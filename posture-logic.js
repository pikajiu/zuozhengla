// 坐姿判断逻辑：只依赖 MediaPipe 输出的关键点，不依赖浏览器，方便单独测试。
// 关键点编号：0 鼻子，7/8 左右耳，11/12 左右肩。
//
// 优先用 worldLandmarks（以米为单位的 3D 坐标），这样手机放正面、侧面还是斜前方，
// 算出来的角度都差不多，也不受人离手机远近影响。没有 3D 坐标时才退回到 2D 画面坐标。

const NOSE = 0, L_EAR = 7, R_EAR = 8, L_SH = 11, R_SH = 12, L_HIP = 23, R_HIP = 24;
const HEAD = [NOSE, L_EAR, R_EAR];
const MIN_VIS = 0.35;

const toDeg = (r) => (r * 180) / Math.PI;

function avg(pts) {
  const n = pts.length;
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / n,
    y: pts.reduce((s, p) => s + p.y, 0) / n,
    z: pts.reduce((s, p) => s + (p.z ?? 0), 0) / n,
  };
}

// 头和肩是否都拍到了（看平均可信度，而不是逐个点，避免某只耳朵时有时无导致数值跳动）
function visible(lm) {
  const vis = (i) => lm[i]?.visibility ?? 1;
  const head = HEAD.reduce((s, i) => s + vis(i), 0) / HEAD.length;
  const sh = (vis(L_SH) + vis(R_SH)) / 2;
  return head >= MIN_VIS && sh >= MIN_VIS;
}

// 从一帧关键点算出几个指标。拍不到头和肩时返回 null。
//   headHeight：头比肩高多少（3D 时单位是米），越小说明头越低
//   neckAngle：肩中点→头中点 这条线偏离竖直方向多少度（低头、探脖子、侧歪都会变大）
//   tilt：两肩连线偏离水平多少度
//   trunk：髋→肩 这条线偏离竖直方向多少度（弯腰、驼背时变大，只有 3D 能算）
//   headAboveHip：头比髋部高多少米（弯腰趴桌时明显变小，只有 3D 能算）
export function measure(lm, world, w = 1, h = 1) {
  if (!lm || lm.length < 13 || !visible(lm)) return null;

  const use3d = world && world.length >= 13;
  const P = use3d
    ? (i) => world[i]
    : (i) => ({ x: lm[i].x * w, y: lm[i].y * h, z: 0 });

  // 头的位置取两耳中点：转头时耳朵中点基本不动，鼻子却会大幅前后左右移动，容易被当成低头
  const le = P(L_EAR), re = P(R_EAR);
  const head = avg([le, re]);
  const ls = P(L_SH), rs = P(R_SH);
  const shoulder = avg([ls, rs]);

  // 转头角度：两耳连线和两肩连线在水平面上的夹角（只有 3D 坐标能算）
  let yaw = null;
  if (use3d) {
    const a1 = Math.atan2(le.z - re.z, le.x - re.x);
    const a2 = Math.atan2(ls.z - rs.z, ls.x - rs.x);
    let d = toDeg(a1 - a2);
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    yaw = d;
  }

  // 图像和 MediaPipe 3D 坐标的 y 轴都是向下的
  const vx = head.x - shoulder.x, vy = head.y - shoulder.y, vz = use3d ? head.z - shoulder.z : 0;
  const headHeight = -vy;
  const len = Math.hypot(vx, vy, vz) || 1;
  const neckAngle = toDeg(Math.acos(Math.max(-1, Math.min(1, -vy / len))));

  let tilt = null;
  const dx = ls.x - rs.x, dy = ls.y - rs.y, dz = use3d ? (ls.z ?? 0) - (rs.z ?? 0) : 0;
  const horiz = Math.hypot(dx, dz);
  // 2D 侧面拍时两肩重叠，算不出歪斜，跳过
  if (use3d || horiz > Math.abs(headHeight) * 0.5) {
    tilt = toDeg(Math.atan2(Math.abs(dy), horiz || 1e-6));
  }

  // 弯腰：头和肩一起往前倒时，头相对肩的角度几乎不变，所以要看躯干和髋部。
  // 3D 坐标以两髋中点为原点，即使髋部被桌子挡住，模型也会估计出来。
  let trunk = null, headAboveHip = null;
  if (use3d) {
    const hip = avg([P(L_HIP), P(R_HIP)]);
    const tx = shoulder.x - hip.x, ty = shoulder.y - hip.y, tz = shoulder.z - hip.z;
    const tl = Math.hypot(tx, ty, tz) || 1;
    trunk = toDeg(Math.acos(Math.max(-1, Math.min(1, -ty / tl))));
    headAboveHip = hip.y - head.y;
  }

  return { headHeight, neckAngle, tilt, yaw, trunk, headAboveHip, mode: use3d ? "3d" : "2d" };
}

// 人脸关键点给出的头部姿态（v7）。matrix 是 FaceLandmarker 的 facialTransformationMatrixes[0]，
// 4x4 矩阵，单位厘米，表示脸在摄像头坐标系里的位置和朝向。拍不到脸时返回空值。
//   facePitch：脸上下转的角度（低头时和基准差得多）
//   faceYaw：脸左右转的角度，比用耳朵和肩膀算更准
//   faceDist：脸离摄像头多远（厘米，估算值，只用来和基准比较远近）
export function faceMeasure(matrix) {
  const d = matrix?.data;
  if (!d || d.length < 16) return { facePitch: null, faceYaw: null, faceDist: null };
  // 兼容按列或按行存放：平移量里 z 的绝对值最大
  const colMajor = Math.abs(d[14]) >= Math.abs(d[11]);
  const t = colMajor ? [d[12], d[13], d[14]] : [d[3], d[7], d[11]];
  const f = colMajor ? [d[8], d[9], d[10]] : [d[2], d[6], d[10]]; // 脸的正前方
  const faceYaw = toDeg(Math.atan2(f[0], f[2]));
  const facePitch = toDeg(Math.atan2(f[1], Math.hypot(f[0], f[2])));
  const faceDist = Math.hypot(t[0], t[1], t[2]);
  if (!(faceDist > 5 && faceDist < 300)) return { facePitch: null, faceYaw: null, faceDist: null };
  return { facePitch, faceYaw, faceDist };
}

// 平滑，减少抖动
const FIELDS = ["headHeight", "neckAngle", "tilt", "yaw", "trunk", "headAboveHip", "facePitch", "faceYaw", "faceDist"];
export const BASE_FIELDS = FIELDS;
export function smooth(prev, next, alpha = 0.3) {
  if (!prev) return next;
  if (!next) return prev;
  const out = { ...next };
  for (const k of FIELDS) {
    const a = prev[k], b = next[k];
    out[k] = a == null || b == null ? b : a + alpha * (b - a);
  }
  return out;
}

// 页面上显示的版本号，用来确认手机加载的是最新代码
export const VERSION = 9;

// 头转开超过这个角度算"东张西望"
export const TURN_LIMIT = 30;

// 灵敏度：数值越小越严格
export const LEVELS = {
  // pitch：脸比基准多低（转）了几度；near：脸比基准离摄像头近了多少
  loose:  { drop: 0.40, neck: 22, tilt: 14, trunk: 20, hipDrop: 0.22, pitch: 28, near: 0.35 },
  normal: { drop: 0.30, neck: 16, tilt: 10, trunk: 14, hipDrop: 0.15, pitch: 20, near: 0.25 },
  strict: { drop: 0.22, neck: 11, tilt: 7, trunk: 10, hipDrop: 0.10, pitch: 14, near: 0.18 },
};

// 和"正确坐姿"基准比较，给出状态和问题。没校准时只返回 need_cal，不提醒。
export function evaluate(m, base, level = "normal") {
  if (!m) return { status: "none", issues: [], detail: null };
  if (!base || !(base.headHeight > 0) || base.mode !== m.mode) {
    return { status: "need_cal", issues: [], detail: null };
  }
  const t = LEVELS[level] || LEVELS.normal;
  const issues = [];
  let warn = false;

  // 头明显转向一边（东张西望、和人说话）：这时其他关键点不可靠，只报转头。
  // 拍得到脸时用人脸算的角度（更准），转得太开拍不到脸时退回用耳朵和肩膀算。
  const diff = (a, b) => { let x = a - b; while (x > 180) x -= 360; while (x < -180) x += 360; return Math.abs(x); };
  const turn = m.faceYaw != null && base.faceYaw != null ? diff(m.faceYaw, base.faceYaw)
    : m.yaw != null && base.yaw != null ? diff(m.yaw, base.yaw) : null;
  if (turn != null && turn > TURN_LIMIT) {
    return { status: "bad", issues: ["头转开了，专心写作业"], detail: { turn } };
  }

  const drop = 1 - m.headHeight / base.headHeight;
  const neck = m.neckAngle - base.neckAngle;
  const tilt = m.tilt != null && base.tilt != null ? m.tilt - base.tilt : null;

  if (drop > t.drop) issues.push("头太低，离桌面太近了");
  else if (drop > t.drop * 0.6) warn = true;

  if (neck > t.neck) issues.push("低头太厉害了");
  else if (neck > t.neck * 0.6) warn = true;

  if (tilt != null && tilt > t.tilt) issues.push("身子歪了，肩膀摆平");

  // 人脸：低头角度和离摄像头远近。手机放在桌上，头往桌面凑时脸会靠近摄像头。
  // 低头方向在不同摆放角度下正负号不确定，所以按和基准差多少算，不分上下。
  const pitch = m.facePitch != null && base.facePitch != null ? diff(m.facePitch, base.facePitch) : null;
  const near = m.faceDist != null && base.faceDist > 0 ? base.faceDist / m.faceDist - 1 : null;
  if (pitch != null && pitch > t.pitch) { if (!issues.includes("低头太厉害了")) issues.push("低头太厉害了"); }
  else if (pitch != null && pitch > t.pitch * 0.6) warn = true;
  if (near != null && near > t.near) issues.unshift("离太近了，抬起头来");
  else if (near != null && near > t.near * 0.6) warn = true;

  const trunk = m.trunk != null && base.trunk != null ? m.trunk - base.trunk : null;
  const hipDrop = m.headAboveHip != null && base.headAboveHip > 0 ? 1 - m.headAboveHip / base.headAboveHip : null;
  if ((trunk != null && trunk > t.trunk) || (hipDrop != null && hipDrop > t.hipDrop)) {
    issues.unshift("弯腰了，把背挺直");
  } else if ((trunk != null && trunk > t.trunk * 0.6) || (hipDrop != null && hipDrop > t.hipDrop * 0.6)) {
    warn = true;
  }

  const status = issues.length ? "bad" : warn ? "warn" : "good";
  return { status, issues, detail: { drop, neck, tilt, turn, trunk, hipDrop, pitch, near } };
}
