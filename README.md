# 坐正啦

写作业坐姿提醒的网页原型。手机放在孩子侧前方，用摄像头在本地识别头和肩膀的位置，低头、离桌太近、探脖子或歪肩持续几秒就语音提醒。画面只在手机上分析，不录像、不上传。

- 在线试用：https://pikajiu.github.io/zuozhengla/
- 姿态识别：MediaPipe Pose Landmarker（Apache-2.0），模型和运行库放在 `vendor/`，不依赖外部 CDN
- 坐姿判断逻辑：`posture-logic.js`

原型版本，仅作习惯提醒，不是医疗检测。
