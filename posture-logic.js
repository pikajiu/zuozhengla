// 坐姿判断逻辑：只依赖 MediaPipe 输出的关键点，不依赖浏览器，方便单独测试。
// 关键点编号：0 鼻子，7/8 左右耳，11/12 左右肩。
//
// 优先用 worldLandmarks（以米为单位的 3D 坐标），这样手机放正面、侧面还是斜前方，
// 算出来的角度都差不多，也不受人离手机远近影响。没有 3D 坐标时才退回到 2D 画面坐标。

const NOSE = 0, L_EAR = 7, R_EAR = 8, L_SH = 11, R_SH = 12;
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
export function measure(lm, world, w = 1, h = 1) {
  if (!lm || lm.length < 13 || !visible(lm)) return null;

  const use3d = world && world.length >= 13;
  const P = use3d
    ? (i) => world[i]
    : (i) => ({ x: lm[i].x * w, y: lm[i].y * h, z: 0 });

  const head = avg(HEAD.map(P));
  const ls = P(L_SH), rs = P(R_SH);
  const shoulder = avg([ls, rs]);

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

  return { headHeight, neckAngle, tilt, mode: use3d ? "3d" : "2d" };
}

// 平滑，减少抖动
export function smooth(prev, next, alpha = 0.3) {
  if (!prev) return next;
  if (!next) return prev;
  const out = { ...next };
  for (const k of ["headHeight", "neckAngle", "tilt"]) {
    const a = prev[k], b = next[k];
    out[k] = a == null || b == null ? b : a + alpha * (b - a);
  }
  return out;
}

// 灵敏度：数值越小越严格
export const LEVELS = {
  loose:  { drop: 0.40, neck: 22, tilt: 14 },
  normal: { drop: 0.30, neck: 16, tilt: 10 },
  strict: { drop: 0.22, neck: 11, tilt: 7 },
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

  const drop = 1 - m.headHeight / base.headHeight;
  const neck = m.neckAngle - base.neckAngle;
  const tilt = m.tilt != null && base.tilt != null ? m.tilt - base.tilt : null;

  if (drop > t.drop) issues.push("头太低，离桌面太近了");
  else if (drop > t.drop * 0.6) warn = true;

  if (neck > t.neck) issues.push("低头太厉害了");
  else if (neck > t.neck * 0.6) warn = true;

  if (tilt != null && tilt > t.tilt) issues.push("身子歪了，肩膀摆平");

  const status = issues.length ? "bad" : warn ? "warn" : "good";
  return { status, issues, detail: { drop, neck, tilt } };
}
