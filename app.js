import { FilesetResolver, FaceLandmarker } from "./vendor/vision_bundle.js";

/* ---------------- 配置 ---------------- */

const CFG = {
  CLOSE_TH: 0.5, // 闭眼判定阈值
  OPEN_TH: 0.25, // 睁眼判定阈值（滞回下限）
  CLOSE_HOLD: 50, // 闭眼持续多久才计数
  STRONG_TH: 0.75, // 强闭眼：单帧即可计数，适配快速眨眼
  OPEN_HOLD: 100, // 睁眼持续多久才允许下一次
  MIN_GAP: 200, // 两次计数最小间隔
  MISS_FRAMES: 5, // 连续丢脸多少帧判定为看不清
};

const MODEL_URL = "./models/face_landmarker.task";
const WASM_BASE = "./vendor/wasm";

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const ctx = overlay.getContext("2d");

const STATE_TEXT = { OPEN: "睁眼", CLOSED: "闭眼", UNKNOWN: "看不清" };
const STATE_KEY = { OPEN: "DOWN", CLOSED: "TOP", UNKNOWN: "UNKNOWN" };

const S = {
  mode: "idle", // idle | starting | running | paused | ended
  facing: "user",
  stream: null,
  landmarker: null,
  lastVideoTime: -1,
  startedAt: 0,
  reps: [],
  seq: 0,
  state: "OPEN",
  armed: true,
  closedSince: 0,
  openSince: 0,
  lastBlinkAt: 0,
  missCount: 0,
  level: null,
  notice: null,
  lastStatusKey: "",
  zoom: 1,
  zoomCap: null,
  mirror: true, // 是否对前置画面做反向修正（抵消浏览器的自动镜像）
};

/* ---------------- 状态提示 ---------------- */

function setStatus(title, desc, tone) {
  const key = `${title}|${desc}|${tone || ""}`;
  if (S.lastStatusKey === key) return;
  S.lastStatusKey = key;
  $("statusTitle").textContent = title;
  $("statusDesc").textContent = desc;
  const card = document.querySelector(".status-card");
  if (card) {
    if (tone) card.dataset.tone = tone;
    else delete card.dataset.tone;
  }
}

function notice(title, desc, tone, ms) {
  S.notice = { title, desc, tone, until: performance.now() + ms };
  setStatus(title, desc, tone);
}

function setHud(state, level) {
  const el = $("hudState");
  el.textContent = STATE_TEXT[state] || "就绪";
  el.dataset.state = STATE_KEY[state] || "DOWN";
  $("hudAngle").textContent =
    level != null && Number.isFinite(level) ? `强度 ${level.toFixed(2)}` : "强度 --";
}

function updateStatus() {
  if (S.mode !== "running") return;

  if (S.notice && performance.now() < S.notice.until) {
    setStatus(S.notice.title, S.notice.desc, S.notice.tone);
    return;
  }
  S.notice = null;

  if (S.state === "UNKNOWN") {
    setStatus("看不清：没有检测到人脸", "请正对镜头，让脸部完整出现在画面中，计数已暂停。", "warn");
    return;
  }

  if (S.state === "CLOSED") {
    setStatus("已计数", "睁眼并保持一瞬，就可以记下一次。");
  } else if (S.armed) {
    setStatus("就绪", "正常眨一次眼即可计数。");
  } else {
    setStatus("等待睁眼", "请先完全睁开眼睛，再眨下一次。");
  }
}

/* ---------------- 模型 ---------------- */

let modelPromise = null;

function ensureModel() {
  if (S.landmarker) return Promise.resolve();
  if (modelPromise) return modelPromise;

  modelPromise = (async () => {
    setStatus("正在加载人脸模型", "首次需要下载约 13MB 推理资源，之后会走缓存。");
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    S.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    console.info("[face] model ready");
  })();

  return modelPromise;
}

async function warmupModel() {
  const start = performance.now();
  const timer = setInterval(() => {
    if (S.landmarker) return;
    const s = Math.round((performance.now() - start) / 1000);
    if (S.mode === "idle") {
      setStatus("正在预加载人脸模型", `已等待 ${s}s，加载完成后点「开始」可立即识别。`);
    }
  }, 1000);

  try {
    await ensureModel();
    if (S.mode === "idle") setStatus("就绪", "模型已就绪，点击「开始」授权摄像头。");
  } catch (err) {
    console.error(err);
    modelPromise = null;
    if (S.mode === "idle") {
      setStatus("模型加载失败", "请刷新页面重试；若反复失败，请更换浏览器或网络。", "warn");
    }
  } finally {
    clearInterval(timer);
  }
}

/* ---------------- 主循环 ---------------- */

function loop() {
  requestAnimationFrame(loop);
  if (!S.landmarker || !S.stream || video.readyState < 2) return;
  const now = performance.now();
  if (video.currentTime === S.lastVideoTime) return;
  S.lastVideoTime = video.currentTime;

  let res;
  try {
    res = S.landmarker.detectForVideo(video, now);
  } catch (err) {
    console.warn("detectForVideo failed", err);
    return;
  }
  handleFrame(res, now);
}

function readBlink(shapes) {
  if (!shapes || !Array.isArray(shapes.categories)) return null;
  let left = null;
  let right = null;
  for (const c of shapes.categories) {
    if (c.categoryName === "eyeBlinkLeft") left = c.score;
    else if (c.categoryName === "eyeBlinkRight") right = c.score;
  }
  if (left == null || right == null) return null;
  return Math.min(left, right); // 取较小值：只有双眼都闭合才算眨眼
}

function handleFrame(res, now) {
  const faces = res.faceLandmarks || [];
  const shapes = res.faceBlendshapes || [];

  if (!faces.length) {
    S.missCount += 1;
    S.level = null;
    drawFace(null, null);
    if (S.mode === "running") {
      if (S.missCount >= CFG.MISS_FRAMES) enterUnknown();
      setHud("UNKNOWN", null);
      updateStatus();
    }
    return;
  }

  S.missCount = 0;
  const lm = faces[0];
  const level = readBlink(shapes[0]);
  S.level = level;
  drawFace(lm, level);

  if (S.mode === "running") {
    updateFSM(level, now);
    setHud(S.state, level);
    updateStatus();
  }
}

/* ---------------- 计数状态机 ---------------- */

function enterUnknown() {
  if (S.state === "UNKNOWN") return;
  S.state = "UNKNOWN";
  S.armed = false;
  S.closedSince = 0;
  S.openSince = 0;
}

function updateFSM(level, now) {
  if (level == null) return;

  /* 看不清恢复：必须先确认睁眼 */
  if (S.state === "UNKNOWN") {
    if (level <= CFG.OPEN_TH) {
      if (!S.openSince) S.openSince = now;
      if (now - S.openSince >= CFG.OPEN_HOLD) {
        S.state = "OPEN";
        S.armed = true;
        S.openSince = 0;
        S.closedSince = 0;
      }
    } else {
      S.openSince = 0;
    }
    return;
  }

  if (S.armed) {
    if (level >= CFG.CLOSE_TH) {
      if (!S.closedSince) S.closedSince = now;
      const held = now - S.closedSince >= CFG.CLOSE_HOLD;
      const strong = level >= CFG.STRONG_TH; // 快速眨眼可能只被采到一帧
      if ((held || strong) && now - S.lastBlinkAt >= CFG.MIN_GAP) {
        const latency = Math.round(now - S.closedSince);
        registerRep(latency, S.level);
        S.lastBlinkAt = now;
        S.armed = false;
        S.state = "CLOSED";
        S.closedSince = 0;
        S.openSince = 0;
      }
    } else {
      S.closedSince = 0;
    }
    return;
  }

  /* 未武装：必须睁眼保持一段，才能记下一次 */
  if (level <= CFG.OPEN_TH) {
    if (!S.openSince) S.openSince = now;
    if (now - S.openSince >= CFG.OPEN_HOLD) {
      S.state = "OPEN";
      S.armed = true;
      S.openSince = 0;
      S.closedSince = 0;
    }
  } else {
    S.openSince = 0;
  }
}

/* ---------------- 记录与统计 ---------------- */

function registerRep(latency, level) {
  const rep = {
    id: ++S.seq,
    t: Date.now(),
    auto: true,
    deleted: false,
    latency,
    level,
  };
  S.reps.push(rep);
  renderAll();
  flashPlus();
}

function recompute() {
  let auto = 0;
  let manual = 0;
  let deleted = 0;
  for (const r of S.reps) {
    if (r.deleted) {
      deleted += 1;
    } else if (r.auto) {
      auto += 1;
    } else {
      manual += 1;
    }
  }
  return { auto, manual, deleted };
}

function renderAll() {
  renderCounters();
  renderLog();
  updateButtons();
}

function renderCounters() {
  const c = recompute();
  $("count").textContent = String(c.auto + c.manual);
  $("countSplit").textContent = `自动 ${c.auto} · 补记 ${c.manual} · 已撤销 ${c.deleted}`;
}

function formatClock(ts) {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function renderLog() {
  const list = $("log");
  list.innerHTML = "";
  for (const r of [...S.reps].reverse()) {
    const li = document.createElement("li");
    li.className = `log-item${r.deleted ? " is-deleted" : ""}`;
    li.dataset.id = String(r.id);
    li.innerHTML = `
      <span class="log-idx">#${r.id}</span>
      <span class="log-time">${formatClock(r.t)}</span>
      <span class="chip" data-v="${r.auto ? "standard" : "manual"}">${r.auto ? "自动" : "补记"}</span>
      <span class="log-flags">${r.auto ? `闭眼强度 ${(r.level ?? 0).toFixed(2)}` : "手动补记"}</span>
      <span class="log-lat">${r.latency != null ? `${r.latency}ms` : "--"}</span>
    `;
    li.addEventListener("click", () => toggleRep(r.id));
    list.appendChild(li);
  }
  $("logEmpty").hidden = S.reps.length > 0;
}

function toggleRep(id) {
  const rep = S.reps.find((r) => r.id === id);
  if (!rep) return;
  rep.deleted = !rep.deleted;
  renderAll();
}

function undoLast() {
  const target = [...S.reps].reverse().find((r) => !r.deleted);
  if (!target) return;
  target.deleted = true;
  renderAll();
}

function addManual() {
  if (S.mode !== "running" && S.mode !== "paused") return;
  const rep = {
    id: ++S.seq,
    t: Date.now(),
    auto: false,
    deleted: false,
    latency: null,
    level: null,
  };
  S.reps.push(rep);
  renderAll();
}

function flashPlus() {
  const el = $("flash");
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
}

/* ---------------- 画面绘制 ---------------- */

let dpr = 1;

function resizeOverlay() {
  const rect = overlay.getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (overlay.width !== w || overlay.height !== h) {
    overlay.width = w;
    overlay.height = h;
  }
  return { w: rect.width, h: rect.height };
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawFace(lm, level) {
  const { w, h } = resizeOverlay();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!lm) return;

  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const p of lm) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  const closed = level != null && level >= CFG.CLOSE_TH;
  const color = closed ? "#f5a524" : "#35d68a";

  // 前置画面被 CSS 翻转时，画布坐标同步映射，保证框和眼睛对齐
  const flip = S.mirror && S.facing === "user";
  const X = (x) => (flip ? 1 - x : x) * w;

  const pad = 8;
  const xa = X(minX);
  const xb = X(maxX);
  const left = Math.min(xa, xb);
  const width = Math.abs(xb - xa);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.9;
  roundRect(ctx, left - pad, minY * h - pad, width + pad * 2, (maxY - minY) * h + pad * 2, 12);
  ctx.stroke();

  // 双眼（外眼角到内眼角）
  const eyePairs = [
    [33, 133],
    [362, 263],
  ];
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  for (const [a, b] of eyePairs) {
    const pa = lm[a];
    const pb = lm[b];
    if (!pa || !pb) continue;
    ctx.beginPath();
    ctx.moveTo(X(pa.x), pa.y * h);
    ctx.lineTo(X(pb.x), pb.y * h);
    ctx.stroke();
  }

  if (level != null) {
    ctx.globalAlpha = 1;
    ctx.font = "600 15px system-ui, sans-serif";
    ctx.fillStyle = color;
    ctx.fillText(`眨眼强度 ${level.toFixed(2)}`, left - pad, Math.max(20, minY * h - pad - 8));
  }
  ctx.globalAlpha = 1;
}

/* ---------------- 镜像修正 ---------------- */

function applyMirror() {
  const on = S.mirror && S.facing === "user";
  video.style.transform = on ? "scaleX(-1)" : "";
  // 画布不做 CSS 翻转（否则文字会反），改在绘制时对坐标做同样的映射
  overlay.style.transform = "";
  const btn = $("btnMirror");
  btn.classList.toggle("is-on", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

function toggleMirror() {
  S.mirror = !S.mirror;
  applyMirror();
}

/* ---------------- 摄像头 ---------------- */

async function ensureCamera() {
  if (S.stream) return;

  setStatus("正在连接摄像头", "首次使用时浏览器会弹出权限请求，请点“允许”。");

  const stream = await requestCameraStream();
  S.stream = stream;
  video.srcObject = stream;
  await video.play();
  $("videoEmpty").hidden = true;
  $("camStatus").dataset.on = "true";
  $("camStatusText").textContent = "摄像头工作中";
  $("btnCamOff").hidden = false;
  $("btnFlip").hidden = false;
  $("btnMirror").hidden = false;
  applyMirror();
  setupZoom();
  acquireWakeLock();
}

function requestCameraStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = new Error("当前页面无法调用摄像头");
    err.name = "InsecureContextError";
    return Promise.reject(err);
  }

  const req = navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: S.facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });

  let settled = false;
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      if (settled) return;
      const err = new Error("摄像头请求超时");
      err.name = "TimeoutError";
      reject(err);
    }, 12000);
  });

  return Promise.race([req, timeout]).then(
    (stream) => {
      settled = true;
      return stream;
    },
    (err) => {
      settled = true;
      req.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
      throw err;
    }
  );
}

function stopCamera() {
  if (S.stream) {
    S.stream.getTracks().forEach((t) => t.stop());
    S.stream = null;
  }
  video.srcObject = null;
  S.mode = "idle";
  S.lastVideoTime = -1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  $("videoEmpty").hidden = false;
  $("camStatus").dataset.on = "false";
  $("camStatusText").textContent = "摄像头未开启";
  $("btnCamOff").hidden = true;
  $("btnFlip").hidden = true;
  $("btnMirror").hidden = true;
  $("zoomCtl").hidden = true;
  $("hint").hidden = true;
  releaseWakeLock();
  setStatus("就绪", "摄像头已关闭。点击「开始」可重新开始。");
  updateButtons();
}

async function flipCamera() {
  if (!S.stream) return;
  S.facing = S.facing === "user" ? "environment" : "user";

  S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
  S.lastVideoTime = -1;
  S.state = "OPEN";
  S.armed = true;
  S.closedSince = 0;
  S.openSince = 0;

  try {
    await ensureCamera();
    if (S.mode === "running") setStatus("就绪", "已切换摄像头，正对镜头后继续。");
  } catch (err) {
    handleCameraError(err);
  }
}

/* ---------------- 摄像头变焦（调用硬件能力） ---------------- */

function setupZoom() {
  const track = S.stream ? S.stream.getVideoTracks()[0] : null;
  const caps = track && typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
  const z = caps ? caps.zoom : null;

  if (!z || !Number.isFinite(z.max) || z.max <= z.min) {
    S.zoomCap = null;
    $("zoomCtl").hidden = true;
    return;
  }

  S.zoomCap = z;
  const cur = track.getSettings ? track.getSettings().zoom : null;
  S.zoom = Number.isFinite(cur) ? cur : z.min;
  $("zoomCtl").hidden = false;
  updateZoomLabel();
}

function updateZoomLabel() {
  $("zoomVal").textContent = `${S.zoom.toFixed(1)}×`;
}

function zoomStep() {
  if (!S.zoomCap) return 0;
  const { min, max, step } = S.zoomCap;
  return Math.max((max - min) / 10, step || 0.1);
}

async function setZoom(value) {
  if (!S.zoomCap || !S.stream) return;
  const track = S.stream.getVideoTracks()[0];
  const { min, max, step } = S.zoomCap;
  let v = Math.min(max, Math.max(min, value));
  if (step) v = Math.round(v / step) * step;

  try {
    await track.applyConstraints({ advanced: [{ zoom: v }] });
    S.zoom = v;
    updateZoomLabel();
  } catch (err) {
    console.warn("变焦失败", err);
  }
}

/* ---------------- 屏幕常亮 ---------------- */

let wakeLock = null;

async function acquireWakeLock() {
  try {
    if (!("wakeLock" in navigator) || wakeLock) return;
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (err) {
    /* 忽略 */
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.stream) acquireWakeLock();
});

/* ---------------- 会话控制 ---------------- */

function resetSession() {
  S.reps = [];
  S.seq = 0;
  S.startedAt = Date.now();
  S.state = "OPEN";
  S.armed = true;
  S.closedSince = 0;
  S.openSince = 0;
  S.lastBlinkAt = 0;
  S.missCount = 0;
  S.level = null;
  S.notice = null;
  S.lastStatusKey = "";
  renderAll();
}

async function startSession() {
  if (S.mode !== "idle" && S.mode !== "ended") return;
  S.mode = "starting";
  updateButtons();
  resetSession();

  const mp = ensureModel();
  mp.catch(() => {});

  try {
    await ensureCamera();
  } catch (err) {
    handleCameraError(err);
    return;
  }

  try {
    await mp;
  } catch (err) {
    console.error(err);
    modelPromise = null;
    S.mode = "idle";
    setStatus("模型加载失败", "请刷新页面重试；若仍失败，请确认 models 与 vendor 目录可正常访问。", "warn");
    updateButtons();
    return;
  }

  S.mode = "running";
  S.state = "OPEN";
  S.armed = true;
  setHud("OPEN", null);
  setStatus("就绪", "正对镜头，正常眨一次眼即可计数。");
  updateButtons();
}

function pauseSession() {
  if (S.mode !== "running") return;
  S.mode = "paused";
  setStatus("已暂停", "计数已暂停，点「继续」或「结束」查看统计。");
  updateButtons();
}

function resumeSession() {
  if (S.mode !== "paused") return;
  S.mode = "running";
  S.state = "OPEN";
  S.armed = true;
  S.closedSince = 0;
  S.openSince = 0;
  setStatus("就绪", "继续正常眨眼即可。");
  updateButtons();
}

function endSession() {
  if (S.mode !== "running" && S.mode !== "paused") return;
  S.mode = "ended";
  openSummary();
  updateButtons();
}

function openSummary() {
  const c = recompute();
  const lat = S.reps.filter((r) => r.auto && !r.deleted && r.latency != null).map((r) => r.latency);
  const avg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;

  $("sumAuto").textContent = String(c.auto);
  $("sumManual").textContent = String(c.manual);
  $("sumDeleted").textContent = String(c.deleted);
  $("sumLatency").textContent = avg != null ? `${avg}ms` : "--";
  $("summaryNote").textContent =
    c.deleted > 0
      ? "已撤销的记录仍保留在列表里，可点击恢复。"
      : "如需修正误计或漏计，可关闭后在记录里撤销或补记。";
  $("summaryModal").hidden = false;
}

/* ---------------- 按钮状态 ---------------- */

function updateButtons() {
  const m = S.mode;
  $("btnStart").disabled = !(m === "idle" || m === "ended");
  $("btnPause").disabled = !(m === "running" || m === "paused");
  $("btnPause").textContent = m === "paused" ? "继续" : "暂停";
  $("btnEnd").disabled = !(m === "running" || m === "paused");

  const canEdit = m === "running" || m === "paused" || m === "ended";
  $("btnUndo").disabled = !canEdit || !S.reps.some((r) => !r.deleted);
  $("btnManual").disabled = !(m === "running" || m === "paused");
}

/* ---------------- 摄像头错误 ---------------- */

function handleCameraError(err) {
  const name = err && err.name ? err.name : "";
  const map = {
    NotAllowedError: ["摄像头权限被拒绝", "点地址栏左侧的摄像头图标把权限改为“允许”，然后点「开始」重试。"],
    NotFoundError: ["没有找到摄像头", "请连接摄像头，或检查设备是否被其他程序占用。"],
    NotReadableError: ["摄像头被占用", "请关闭正在使用摄像头的其他软件（会议、录屏等）后重试。"],
    OverconstrainedError: ["摄像头不支持该分辨率", "请更换设备后重试。"],
    TimeoutError: [
      "摄像头没有响应",
      "浏览器既没有弹权限框也没有返回画面。请用 Chrome / Edge 直接打开本页（不要用 IDE 内置预览），并检查系统设置 → 隐私 → 相机。",
    ],
    InsecureContextError: ["无法调用摄像头", "请通过 https 或 http://127.0.0.1 访问本页。"],
    SecurityError: ["摄像头被浏览器安全策略拦截", "请用独立浏览器标签页打开，不要嵌套在其他预览窗口中。"],
  };
  const [title, desc] = map[name] || ["无法打开摄像头", `请检查设备与浏览器权限后重试（${name || "未知错误"}）。`];
  console.error("[camera]", err);
  S.mode = "idle";
  setStatus(title, desc, "warn");
  updateButtons();
}

/* ---------------- 事件绑定 ---------------- */

$("btnStart").addEventListener("click", startSession);
$("btnPause").addEventListener("click", () => (S.mode === "paused" ? resumeSession() : pauseSession()));
$("btnEnd").addEventListener("click", endSession);
$("btnUndo").addEventListener("click", undoLast);
$("btnManual").addEventListener("click", addManual);
$("btnCamOff").addEventListener("click", stopCamera);
$("btnMirror").addEventListener("click", toggleMirror);
$("btnFlip").addEventListener("click", flipCamera);
$("zoomIn").addEventListener("click", () => setZoom(S.zoom + zoomStep()));
$("zoomOut").addEventListener("click", () => setZoom(S.zoom - zoomStep()));
$("zoomVal").addEventListener("click", () => setZoom(S.zoomCap ? S.zoomCap.min : 1));
$("btnCloseSummary").addEventListener("click", () => {
  $("summaryModal").hidden = true;
});
$("btnResume").addEventListener("click", () => {
  $("summaryModal").hidden = true;
  resumeSession();
});

document.addEventListener("keydown", (e) => {
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undoLast();
  } else if (e.code === "Space") {
    e.preventDefault();
    addManual();
  }
});

/* ---------------- 启动 ---------------- */

window.addEventListener("beforeunload", () => {
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
});

window.__appReady = true;

if (window.self !== window.top) {
  setStatus(
    "建议在独立标签页打开",
    "当前页面嵌在预览窗口里，浏览器可能拦截摄像头授权。请复制地址后用 Chrome / Edge 直接打开。",
    "warn"
  );
}

renderAll();
warmupModel();
requestAnimationFrame(loop);
