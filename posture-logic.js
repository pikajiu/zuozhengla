// 坐姿判断逻辑：只依赖 MediaPipe 输出的关键点，不依赖浏览器，方便单独测试。
// 关键点编号：0 鼻子，7/8 左右耳，11/12 左右肩。

const NOSE = 0, L_EAR = 7, R_EAR = 8, L_SH = 11, R_SH = 12;
const MIN_VIS = 0.5;

const toDeg = (r) => (r * 180) / Math.PI;

function pt(lm, i, w, h) {
  const p = lm[i];
  if (!p || (p.visibility ?? 1) < MIN_VIS) return null;
  return { x: p.x * w, y: p.y * h, v: p.visibility ?? 1 };
}

function mid(a, b) {
  if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return a || b || null;
}

// 从一帧关键点算出几个指标（像素单位）。拍不到头和肩时返回 null。
export function measure(lm, w, h) {
  if (!lm || !lm.length) return null;
  const le = pt(lm, L_EAR, w, h), re = pt(lm, R_EAR, w, h);
  const ls = pt(lm, L_SH, w, h), rs = pt(lm, R_SH, w, h);
  const nose = pt(lm, NOSE, w, h);
  const shoulder = mid(ls, rs);
  const head = mid(le, re) || nose;
  if (!shoulder || !head) return null;

  // 头比肩高多少：越小说明头越低、越贴近桌面
  const headHeight = shoulder.y - head.y;

  // 侧面看脖子前倾角度：耳朵相对肩膀往前探了多少度（0 = 竖直）
  let neckAngle = null;
  const sides = [[le, ls], [re, rs]].filter(([e, s]) => e && s);
  if (sides.length) {
    sides.sort((a, b) => b[0].v + b[1].v - (a[0].v + a[1].v));
    const [e, s] = sides[0];
    neckAngle = toDeg(Math.atan2(Math.abs(e.x - s.x), Math.max(1, s.y - e.y)));
  }

  // 正面看肩膀歪斜角度
  let tilt = null;
  if (ls && rs && Math.abs(ls.x - rs.x) > 20) {
    tilt = toDeg(Math.atan2(Math.abs(ls.y - rs.y), Math.abs(ls.x - rs.x)));
  }

  return { headHeight, neckAngle, tilt };
}

// 平滑，减少抖动
export function smooth(prev, next, alpha = 0.3) {
  if (!prev) return next;
  if (!next) return prev;
  const out = {};
  for (const k of Object.keys(next)) {
    const a = prev[k], b = next[k];
    out[k] = a == null || b == null ? b : a + alpha * (b - a);
  }
  return out;
}

// 灵敏度：数值越小越严格
export const LEVELS = {
  loose:  { drop: 0.45, neck: 25, neckAbs: 45, tilt: 14 },
  normal: { drop: 0.35, neck: 18, neckAbs: 38, tilt: 10 },
  strict: { drop: 0.25, neck: 12, neckAbs: 30, tilt: 7 },
};

// 和"正确坐姿"基准比较，给出状态和问题
export function evaluate(m, base, level = "normal") {
  if (!m) return { status: "none", issues: [] };
  const t = LEVELS[level] || LEVELS.normal;
  const issues = [];
  let warn = false;

  if (base && base.headHeight > 0) {
    const drop = 1 - m.headHeight / base.headHeight;
    if (drop > t.drop) issues.push("头太低，离桌面太近了");
    else if (drop > t.drop * 0.6) warn = true;
  }

  if (m.neckAngle != null) {
    if (base && base.neckAngle != null) {
      const d = m.neckAngle - base.neckAngle;
      if (d > t.neck) issues.push("脖子往前探了");
      else if (d > t.neck * 0.6) warn = true;
    } else if (m.neckAngle > t.neckAbs) {
      issues.push("低头太厉害了");
    }
  }

  if (m.tilt != null) {
    const d = m.tilt - (base?.tilt ?? 0);
    if (d > t.tilt) issues.push("身子歪了，肩膀摆平");
  }

  const status = issues.length ? "bad" : warn ? "warn" : "good";
  return { status, issues };
}
