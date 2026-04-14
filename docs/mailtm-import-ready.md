# Mail.tm API 精简导入文档（适合导入 AI-Test-API）

## 导入注意事项

1. 这是 REST API 文档。
2. 文档中的 HTTP 状态码（如 200、201）只是 HTTP 层结果，不是业务码。
3. 对于这些接口，不要假设响应 JSON 中一定有 `code`、`businessCode`、`bizCode`。
4. 生成测试用例时：
   - **不要默认填写 expected.businessCode**
   - 优先使用字段存在、字段相等、字段非空等断言
5. 这套接口适合做多步骤场景测试：
   - 获取域名
   - 创建账号
   - 获取 token
   - 查询消息
   - 查询当前账号信息

---

## Base URL

```text
https://api.mail.tm
```

---

## 接口 1：获取可用域名

### 请求
```http
GET /domains
```

### 完整地址
```http
GET https://api.mail.tm/domains
```

### 用途
获取当前可用邮箱域名，用于后续拼接邮箱地址。

### 典型响应字段
```json
{
  "hydra:member": [
    {
      "id": "domain_id",
      "domain": "example.com",
      "isActive": true,
      "isPrivate": false,
      "createdAt": "2025-01-01T00:00:00+00:00",
      "updatedAt": "2025-01-01T00:00:00+00:00"
    }
  ]
}
```

### 推荐提取
- `mailDomain` ← `$.hydra:member.0.domain`

### 推荐断言
- `$.hydra:member.0.domain` 存在
- `$.hydra:member.0.isActive` 等于 `true`

### 生成用例要求
- **不要填写 expected.businessCode**

---

## 接口 2：创建邮箱账号

### 请求
```http
POST /accounts
Content-Type: application/json
```

### 完整地址
```http
POST https://api.mail.tm/accounts
```

### 请求体
```json
{
  "address": "aitestapi_{{seed}}@{{mailDomain}}",
  "password": "Shaqiang123!"
}
```

### 用途
创建一个真实可用的临时邮箱账号。

### 典型响应字段
```json
{
  "id": "account_id",
  "address": "aitestapi_xxx@example.com",
  "quota": 40000000,
  "used": 0,
  "isDisabled": false,
  "isDeleted": false,
  "createdAt": "2026-01-01T00:00:00+00:00",
  "updatedAt": "2026-01-01T00:00:00+00:00"
}
```

### 推荐提取
- `mailAddress` ← `$.address`
- `accountId` ← `$.id`

### 推荐断言
- `$.id` 存在
- `$.address` 存在
- `$.isDisabled` 等于 `false`
- `$.isDeleted` 等于 `false`

### 生成用例要求
- **不要填写 expected.businessCode**
- 重点断言对象字段，不要把 HTTP 201 当业务码

---

## 接口 3：获取登录 Token

### 请求
```http
POST /token
Content-Type: application/json
```

### 完整地址
```http
POST https://api.mail.tm/token
```

### 请求体
```json
{
  "address": "{{mailAddress}}",
  "password": "Shaqiang123!"
}
```

### 用途
根据邮箱地址和密码获取 Bearer Token。

### 典型响应字段
```json
{
  "token": "jwt_token_value",
  "id": "account_id"
}
```

### 推荐提取
- `mailToken` ← `$.token`

### 推荐断言
- `$.token` 存在
- `$.id` 存在

### 生成用例要求
- **不要填写 expected.businessCode**

---

## 接口 4：查询消息列表

### 请求
```http
GET /messages
Authorization: Bearer {{mailToken}}
```

### 完整地址
```http
GET https://api.mail.tm/messages
```

### 用途
查询当前邮箱账号收到的邮件列表。

### 请求头
```json
{
  "Authorization": "Bearer {{mailToken}}"
}
```

### 典型响应字段
```json
{
  "hydra:totalItems": 0,
  "hydra:member": []
}
```

### 推荐断言
- `$.hydra:member` 存在
- `$.hydra:totalItems` 存在

### 生成用例要求
- **不要填写 expected.businessCode**
- 这是认证接口，必须支持变量注入到 Header

---

## 接口 5：查询当前账号信息

### 请求
```http
GET /me
Authorization: Bearer {{mailToken}}
```

### 完整地址
```http
GET https://api.mail.tm/me
```

### 用途
验证 token 是否有效，并返回当前邮箱账号信息。

### 请求头
```json
{
  "Authorization": "Bearer {{mailToken}}"
}
```

### 典型响应字段
```json
{
  "id": "account_id",
  "address": "aitestapi_xxx@example.com",
  "quota": 40000000,
  "used": 0,
  "isDisabled": false,
  "isDeleted": false,
  "createdAt": "2026-01-01T00:00:00+00:00",
  "updatedAt": "2026-01-01T00:00:00+00:00"
}
```

### 推荐断言
- `$.id` 存在
- `$.address` 等于 `{{mailAddress}}`
- `$.isDisabled` 等于 `false`

### 生成用例要求
- **不要填写 expected.businessCode**

---

## 推荐场景：创建临时邮箱并完成认证链路

### 步骤 1：获取域名
- 请求：`GET /domains`
- 提取：`mailDomain`

### 步骤 2：创建账号
- 请求：`POST /accounts`
- 请求体中的地址使用：`aitestapi_{{seed}}@{{mailDomain}}`
- 提取：`mailAddress`、`accountId`

### 步骤 3：获取 token
- 请求：`POST /token`
- 请求体使用：`{{mailAddress}}`
- 提取：`mailToken`

### 步骤 4：查询消息列表
- 请求：`GET /messages`
- Header：`Authorization: Bearer {{mailToken}}`

### 步骤 5：查询当前账号
- 请求：`GET /me`
- Header：`Authorization: Bearer {{mailToken}}`
- 断言：`$.address == {{mailAddress}}`

---

## 导入生成规则（给 AI 的明确要求）

生成接口和用例时，必须遵守以下规则：

1. 不要把 HTTP 状态码写入 `expected.businessCode`
2. 如果响应示例中没有明确的业务码字段，则 `expected.businessCode` 置空
3. 优先生成以下断言：
   - exists
   - equals
   - notEmpty
4. 对 `Authorization` 头支持变量引用：`Bearer {{mailToken}}`
5. 创建账号步骤需要支持动态地址，例如：
   - `aitestapi_{{seed}}@{{mailDomain}}`
6. 场景编排中必须包含变量提取与后续引用

---

## 不推荐的错误做法

### 错误做法 1
把 200 / 201 填进 `expected.businessCode`

### 错误做法 2
假设响应体中一定有：
- `code`
- `businessCode`
- `msg`

### 错误做法 3
把消息列表接口当作无认证接口使用

---

## 适合测试的平台能力

这份文档最适合验证以下能力：

- Markdown 文档导入
- AI 自动生成接口
- AI 自动生成用例
- 变量提取
- 变量引用
- Header 鉴权注入
- 场景编排
- 执行结果校对
