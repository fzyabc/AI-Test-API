# Mail.tm 测试接口文档（实测可用版）

## 结论

这套 API **不是假数据演示站**，而是我刚刚实测通过的一套“有真实效果”的公开 API。

> ⚠️ 关键说明（这次你指出的问题就是这里）
>
> Mail.tm 文档里写的 `200 / 201`，**是 HTTP 状态码，不是业务码**。
>
> 你在 AI-Test-API 里如果把：
> - `200`
> - `201`
>
> 填到 **期望业务码**，大概率会失败，因为 Mail.tm 的响应 JSON 通常**没有 `code` / `businessCode` 这类字段**。
>
> 所以这套接口的正确用法是：
> - **不要填业务码**
> - 改用字段存在断言 / 内容断言
> - 把文档里的 `200 / 201` 只当成 HTTP 状态参考，不当成 `expected.businessCode`

它具备这些特点：
- 能真实创建临时邮箱账号
- 能真实获取 Bearer Token
- 能真实查询账号信息
- 能真实查询邮件列表
- 后续还能继续测单条邮件详情 / 删除 / SSE

非常适合你现在这个平台做：
- 文档导入
- case_runner 执行
- token 串联
- 变量提取
- 场景编排
- 失败处理

---

## 实测信息

- **官网文档**：`https://docs.mail.tm/`
- **API Base URL**：`https://api.mail.tm`
- **认证方式**：Bearer Token
- **是否需要 API Key**：不需要

我刚实测成功：
- 获取域名：`200`
- 创建账号：`201`
- 获取 token：`200`
- 查询消息列表：`200`

实测创建的邮箱示例：
```text
aitestapi_1776070490787@deltajohnsons.com
```

---

# 一、推荐测试主链路

这是最适合你平台当前能力的一条链：

1. 获取可用域名
2. 创建邮箱账号
3. 获取 token
4. 查询消息列表
5. 查询账号信息（可选）

这条链是**真正有状态变化**的，不是纯展示型接口。

---

# 二、接口文档

## 1）获取可用域名

```http
GET /domains
```

完整地址：
```http
GET https://api.mail.tm/domains
```

### 实测结果
- HTTP：`200`
- 返回域名集合

### 响应示例
```json
{
  "hydra:member": [
    {
      "@id": "/domains/689c4068c56e0a47b3a44a0b",
      "@type": "Domain",
      "id": "689c4068c56e0a47b3a44a0b",
      "domain": "deltajohnsons.com",
      "isActive": true,
      "isPrivate": false,
      "createdAt": "2025-08-13T12:28:56+00:00",
      "updatedAt": "2025-08-13T12:28:56+00:00"
    }
  ]
}
```

### 在 AI-Test-API 里怎么配
- **期望业务码：留空**
- 不要填 `200`
- 这类接口主要看字段断言

### 建议断言
- `$.hydra:member.0.domain` 存在
- `$.hydra:member.0.isActive == true`

### 适合提取的变量
```json
{ "name": "mailDomain", "source": "response.bodyJson", "path": "$.hydra:member.0.domain" }
```

---

## 2）创建邮箱账号

```http
POST /accounts
Content-Type: application/json
```

完整地址：
```http
POST https://api.mail.tm/accounts
```

### 请求体
```json
{
  "address": "aitestapi_1776070490787@deltajohnsons.com",
  "password": "Shaqiang123!"
}
```

### 实测结果
- HTTP：`201`
- 账号真实创建成功

### 实测响应示例
```json
{
  "@context": "/contexts/Account",
  "@id": "/accounts/69dcaf5bc946d6949606c280",
  "@type": "Account",
  "id": "69dcaf5bc946d6949606c280",
  "address": "aitestapi_1776070490787@deltajohnsons.com",
  "quota": 40000000,
  "used": 0,
  "isDisabled": false,
  "isDeleted": false,
  "createdAt": "2026-04-13T08:54:51+00:00",
  "updatedAt": "2026-04-13T08:54:51+00:00"
}
```

### 在 AI-Test-API 里怎么配
- **期望业务码：留空**
- 不要填 `201`
- 重点看创建后返回对象字段

### 建议断言
- `$.id` 存在
- `$.address` 等于你创建的邮箱地址
- `$.isDisabled == false`
- `$.isDeleted == false`

### 适合提取的变量
```json
{ "name": "mailAddress", "source": "response.bodyJson", "path": "$.address" }
```

```json
{ "name": "accountId", "source": "response.bodyJson", "path": "$.id" }
```

---

## 3）获取 Token

```http
POST /token
Content-Type: application/json
```

完整地址：
```http
POST https://api.mail.tm/token
```

### 请求体
```json
{
  "address": "aitestapi_1776070490787@deltajohnsons.com",
  "password": "Shaqiang123!"
}
```

### 实测结果
- HTTP：`200`
- 能真实拿到 Bearer Token

### 实测响应示例
```json
{
  "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9...",
  "@id": "/accounts/69dcaf5bc946d6949606c280",
  "id": "69dcaf5bc946d6949606c280"
}
```

### 在 AI-Test-API 里怎么配
- **期望业务码：留空**
- 不要填 `200`

### 建议断言
- `$.token` 存在
- `$.id` 存在

### 适合提取的变量
```json
{ "name": "mailToken", "source": "response.bodyJson", "path": "$.token" }
```

---

## 4）查询消息列表

```http
GET /messages
Authorization: Bearer {{mailToken}}
```

完整地址：
```http
GET https://api.mail.tm/messages
```

### 实测结果
- HTTP：`200`
- 新账号初始邮件数为 0

### 实测响应示例
```json
{
  "@context": "/contexts/Message",
  "@id": "/messages",
  "@type": "hydra:Collection",
  "hydra:totalItems": 0,
  "hydra:member": []
}
```

### 在 AI-Test-API 里怎么配
- **期望业务码：留空**
- 不要填 `200`

### 建议断言
- `$.hydra:totalItems >= 0`
- `$.hydra:member` 存在

### 适合验证的能力
- Token 注入
- 授权请求
- 空列表处理
- 场景变量传递

---

## 5）查询账号信息（推荐补测）

```http
GET /me
Authorization: Bearer {{mailToken}}
```

完整地址：
```http
GET https://api.mail.tm/me
```

> 这个接口符合 Mail.tm 常规接口设计，建议你测；如果你导入后需要，我也建议你把它加入场景链路。

### 预期用途
- 验证 token 是否真的生效
- 验证 `accountId` / `address` / `quota` / `used`

---

# 三、先给你一个最重要的配置原则

## 这套接口怎么避免“因为 200/201 失败”

### 错误配法
把文档里的：
- `200`
- `201`

直接填进 AI-Test-API 的：
- `期望业务码`

### 正确配法
对于 Mail.tm 这类接口：
- **期望业务码留空**
- 用字段断言替代业务码断言

也就是你要重点配：
- `exists`
- `equals`
- `contains`
- `notEmpty`

不要把 HTTP 状态码当成 JSON 里的业务码。

---

# 四、推荐你在平台里这样建场景

## 场景 A：完整账号创建链路

### 步骤 1：获取域名
```http
GET /domains
```
提取：
```json
{ "name": "mailDomain", "source": "response.bodyJson", "path": "$.hydra:member.0.domain" }
```

### 步骤 2：创建账号
```http
POST /accounts
```
请求体建议：
```json
{
  "address": "aitestapi_{{seed}}@{{mailDomain}}",
  "password": "Shaqiang123!"
}
```
提取：
```json
{ "name": "mailAddress", "source": "response.bodyJson", "path": "$.address" }
```
```json
{ "name": "accountId", "source": "response.bodyJson", "path": "$.id" }
```

### 步骤 3：获取 token
```http
POST /token
```
请求体：
```json
{
  "address": "{{mailAddress}}",
  "password": "Shaqiang123!"
}
```
提取：
```json
{ "name": "mailToken", "source": "response.bodyJson", "path": "$.token" }
```

### 步骤 4：查询消息列表
```http
GET /messages
Authorization: Bearer {{mailToken}}
```
断言：
```json
{ "type": "exists", "source": "response.bodyJson", "path": "$.hydra:member" }
```

---

# 五、测试时重点看什么

## 1）变量提取和串联
这套 API 最大价值就在这里。

你要重点看：
- 第一步提取的 `mailDomain` 能不能用于第二步
- 第二步提取的 `mailAddress` 能不能用于第三步
- 第三步提取的 `mailToken` 能不能用于第四步 Authorization

如果这条链跑通，说明你平台的：
- 提取变量
- 变量引用
- 场景编排
- Header 注入

基本就是过关的。

---

## 2）真实写操作
这次不是 JSONPlaceholder 那种“假写入”。

这里你真的会得到：
- 一个真实邮箱地址
- 一个真实 token
- 一个真实账户 ID

所以它更适合验证“系统是不是有实际效果”。

---

## 3）异常场景也能测
你还可以测：

### 错误密码拿 token
```http
POST /token
```
传错 password，应该失败。

### 重复创建同一邮箱
```http
POST /accounts
```
同一个 address 再创建一次，应该失败。

### 不带 token 查消息
```http
GET /messages
```
应该失败。

---

# 六、为什么我这次推荐这套
因为它符合你现在真正想测的东西：

- 文档导入
- 有真实副作用
- 多步骤串联
- token 链路
- 回填校对
- 失败重跑

它比刚才那个 JSONPlaceholder 更适合你当前阶段。

---

# 七、我给你的直接结论
如果你现在要**认真验证平台可用性**，优先用这套：

## 推荐接口顺序
1. `GET /domains`
2. `POST /accounts`
3. `POST /token`
4. `GET /messages`
5. `GET /me`

---

如果你要，我下一步可以直接继续给你做两件事之一：

1. **把这份文档再精炼成更适合导入的版本**（少废话、偏接口描述）
2. **直接帮你生成一份适合 AI-Test-API 的接口+场景 JSON 模板**，你拿去就能导入/粘贴测试
