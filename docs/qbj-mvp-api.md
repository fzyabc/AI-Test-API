# 球伴记 MVP API（已落地）

Base URL: `/api/v1`

统一返回：

```json
{
  "code": 0,
  "message": "ok",
  "data": {}
}
```

鉴权：

- 需要登录的接口统一使用 Header：`Authorization: Bearer <token>`

---

## 1) 认证

### POST `/auth/wx-login`

请求：

```json
{
  "code": "wx_login_code",
  "nickname": "老板",
  "avatar": "https://..."
}
```

返回：`token` + `user`

---

## 2) 赛事

### GET `/matches?sportType=football&date=2026-04-20&page=1&pageSize=20`

- `sportType`: `football | basketball`
- `date`: `YYYY-MM-DD`（可选）

### GET `/matches/:matchId`

### POST `/matches/:matchId/follow`

### DELETE `/matches/:matchId/follow`

### GET `/me/follows?date=2026-04-20`

---

## 3) 预算

### GET `/me/budget?cycleType=week`

- `cycleType`: `week | month`

### PUT `/me/budget`

```json
{
  "cycleType": "week",
  "amountTotal": 1000,
  "overLimitMode": "warn"
}
```

- `overLimitMode`: `warn | block`

---

## 4) 记录（核心）

### POST `/records`

```json
{
  "matchId": 9001,
  "pickContent": "主胜",
  "amount": 100,
  "note": "看阵容后决定",
  "status": "draft"
}
```

规则：

- `amount` 必须为正整数
- `status` 只允许 `draft | submitted`
- `submitted` 需要在锁单时间前（默认开赛前 5 分钟）
- 文案过滤敏感词（如：稳赚、包赢、内幕、代投、代购）

### POST `/records/:recordId/submit`

- 草稿转提交，校验预算与锁单时间

### PATCH `/records/:recordId`

- 开赛前允许修改提交记录
- 已结算不可改

### DELETE `/records/:recordId`

- 仅 `draft` 可删

### GET `/records?weekKey=2026-W16&status=submitted&page=1&pageSize=20`

### POST `/records/:recordId/settle`

```json
{
  "result": "win",
  "returnAmount": 190
}
```

- `result`: `win | lose | void`

---

## 5) 周复盘

### POST `/reviews/weekly/generate`

```json
{
  "weekKey": "2026-W16"
}
```

### GET `/reviews/weekly?weekKey=2026-W16`

---

## 6) 海报

### POST `/posters/weekly`

```json
{
  "weekKey": "2026-W16",
  "theme": "dark"
}
```

返回：`posterUrl`、`shareTitle`、`sharePath`

---

## 错误码（当前实现）

- `40001` 参数错误
- `40101` 未登录/Token失效
- `40401` 资源不存在
- `40901` 状态冲突（锁单、预算 block、状态不允许等）

---

## 当前数据存储

为了快速落地 MVP，当前实现使用本地 JSON：

- `data/qbj.json`

生产化可切换为 MySQL，建表见：`docs/qbj-mvp-mysql.sql`
