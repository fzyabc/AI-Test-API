# JSONPlaceholder 测试接口文档（实测修正版）

## 概述

- **BASE_URL**: `https://jsonplaceholder.typicode.com`
- **无需认证**：所有接口公开可访问，不需要 token / API key
- **适用目的**：用于验证 AI-Test-API 的接口请求、断言、场景编排、变量提取、历史记录等能力

> ⚠️ 重要说明：
>
> JSONPlaceholder 的 `POST / PUT / PATCH / DELETE` **是模拟写入**。
> - 会返回看起来成功的响应
> - **但不会真正持久化到后端数据集**
> - 所以你不能假设 `POST /posts` 返回了 `id=101` 之后，再 `GET /posts/101` 就一定能查到
>
> 实测结果：`GET /posts/101` 返回 `404 {}`。

---

## 一、实测接口清单

下面所有响应结论，都基于实际请求验证。

---

## 1）查询单篇文章

```http
GET /posts/1
```

### 实测响应
- HTTP：`200`
- Body：

```json
{
  "userId": 1,
  "id": 1,
  "title": "sunt aut facere repellat provident occaecati excepturi optio reprehenderit",
  "body": "quia et suscipit\nsuscipit recusandae consequuntur expedita et cum\nreprehenderit molestiae ut ut quas totam\nnostrum rerum est autem sunt rem eveniet architecto"
}
```

### 建议断言
- `$.id == 1`
- `$.userId == 1`
- `$.title` 存在
- `$.body` 存在

---

## 2）查询不存在的文章

```http
GET /posts/99999
```

### 实测响应
- HTTP：`404`
- Body：

```json
{}
```

### 重点
这个接口很适合用来测：
- 异常处理
- 404 响应
- stopOnFailure

---

## 3）查询文章列表

```http
GET /posts
GET /posts?userId=1
GET /posts?userId=1&_limit=3
```

### 实测结论
- `GET /posts` 返回文章数组
- `GET /posts?userId=1` 会过滤到指定用户
- `GET /posts?userId=1&_limit=3` 返回 3 条

### 返回结构示例

```json
[
  {
    "userId": 1,
    "id": 1,
    "title": "...",
    "body": "..."
  }
]
```

### 建议断言
- 数组存在
- `length > 0`
- 过滤场景下每条记录的 `userId == 1`

---

## 4）查询用户信息

```http
GET /users/1
```

### 实测响应
- HTTP：`200`
- 返回完整嵌套对象，包含：
  - `id`
  - `name`
  - `username`
  - `email`
  - `address.geo.lat`
  - `company.name`

### 响应示例

```json
{
  "id": 1,
  "name": "Leanne Graham",
  "username": "Bret",
  "email": "Sincere@april.biz",
  "address": {
    "street": "Kulas Light",
    "suite": "Apt. 556",
    "city": "Gwenborough",
    "zipcode": "92998-3874",
    "geo": {
      "lat": "-37.3159",
      "lng": "81.1496"
    }
  },
  "phone": "1-770-736-8031 x56442",
  "website": "hildegard.org",
  "company": {
    "name": "Romaguera-Crona",
    "catchPhrase": "Multi-layered client-server neural-net",
    "bs": "harness real-time e-markets"
  }
}
```

### 建议断言
- `$.id == 1`
- `$.email` 包含 `@`
- `$.address.geo.lat` 存在
- `$.company.name` 存在

---

## 5）查询某用户的文章

```http
GET /users/1/posts
```

### 实测响应
- HTTP：`200`
- 返回数组
- 数组内文章的 `userId` 都是 `1`

### 建议断言
- `length > 0`
- 第一项 `$.userId == 1`

---

## 6）查询某文章的评论

```http
GET /posts/1/comments
GET /posts/1/comments?_limit=2
GET /comments?postId=1
```

### 实测响应
- HTTP：`200`
- 返回评论数组
- `_limit=2` 时返回 2 条

### 返回结构示例

```json
[
  {
    "postId": 1,
    "id": 1,
    "name": "id labore ex et quam laborum",
    "email": "Eliseo@gardner.biz",
    "body": "laudantium enim quasi est quidem magnam voluptate ipsam eos..."
  }
]
```

### 建议断言
- `length > 0`
- 第一项 `$.postId == 1`
- `$.email` 包含 `@`

---

## 7）创建文章（模拟写入）

```http
POST /posts
Content-Type: application/json
```

### 请求体

```json
{
  "title": "测试文章",
  "body": "这是测试内容",
  "userId": 1
}
```

### 实测响应
- HTTP：`201`
- Body：

```json
{
  "title": "测试文章",
  "body": "这是测试内容",
  "userId": 1,
  "id": 101
}
```

### 重点说明
- 返回 `id = 101`
- **这个 101 只是模拟响应，不代表真实创建成功并可回查**
- 实测：

```http
GET /posts/101
```

返回：
- HTTP：`404`
- Body：`{}`

### 建议断言
- HTTP 201
- `$.id == 101`
- `$.title == "测试文章"`
- `$.userId == 1`

---

## 8）创建评论（模拟写入）

```http
POST /comments
Content-Type: application/json
```

### 请求体

```json
{
  "postId": 1,
  "name": "傻强",
  "email": "shaqiang@test.com",
  "body": "测试评论"
}
```

### 实测响应
- HTTP：`201`
- Body：

```json
{
  "postId": 1,
  "name": "傻强",
  "email": "shaqiang@test.com",
  "body": "测试评论",
  "id": 501
}
```

### 建议断言
- `$.id == 501`
- `$.postId == 1`
- `$.email == "shaqiang@test.com"`

---

## 9）创建用户（模拟写入）

```http
POST /users
Content-Type: application/json
```

### 请求体

```json
{
  "name": "测试用户",
  "username": "testuser",
  "email": "test@example.com"
}
```

### 实测响应
- HTTP：`201`
- Body：

```json
{
  "name": "测试用户",
  "username": "testuser",
  "email": "test@example.com",
  "id": 11
}
```

### 建议断言
- `$.id == 11`
- `$.username == "testuser"`

---

## 10）全量更新文章（模拟写入）

```http
PUT /posts/1
Content-Type: application/json
```

### 请求体

```json
{
  "id": 1,
  "title": "更新后的标题",
  "body": "更新后的内容",
  "userId": 1
}
```

### 实测响应
- HTTP：`200`
- Body：

```json
{
  "id": 1,
  "title": "更新后的标题",
  "body": "更新后的内容",
  "userId": 1
}
```

### 建议断言
- `$.id == 1`
- `$.title == "更新后的标题"`
- `$.body == "更新后的内容"`

---

## 11）部分更新文章（模拟写入）

```http
PATCH /posts/1
Content-Type: application/json
```

### 请求体

```json
{
  "title": "只改标题"
}
```

### 实测响应
- HTTP：`200`
- Body：

```json
{
  "userId": 1,
  "id": 1,
  "title": "只改标题",
  "body": "quia et suscipit\nsuscipit recusandae consequuntur expedita et cum\nreprehenderit molestiae ut ut quas totam\nnostrum rerum est autem sunt rem eveniet architecto"
}
```

### 重点说明
- 不是只返回你传的字段
- 会返回完整对象
- `title` 被更新成新值
- 其他字段沿用原有模拟内容

### 建议断言
- `$.id == 1`
- `$.title == "只改标题"`
- `$.body` 存在

---

## 12）删除文章（模拟删除）

```http
DELETE /posts/1
```

### 实测响应
- HTTP：`200`
- Body：

```json
{}
```

### 建议断言
- HTTP 200
- 返回 `{}`

---

## 二、修正后的推荐测试场景

下面这些场景是**实测可用**的，不依赖“模拟写入后可回查”这种错误前提。

---

## 场景 A：基础查询验证

### 步骤
1. `GET /posts/1`
2. `GET /users/1`
3. `GET /posts/1/comments?_limit=2`

### 核心检查点
- 请求是否正常发出
- 嵌套 JSON 是否能正确解析
- 数组断言是否工作正常

---

## 场景 B：提取变量并串联真实可查接口

这个场景比“POST 后再 GET”更靠谱。

### 步骤 1：查询文章
```http
GET /posts/1
```

### 从响应中提取
```json
{ "name": "userId", "source": "response.bodyJson", "path": "$.userId" }
```

### 步骤 2：查询该用户资料
```http
GET /users/{{userId}}
```

### 断言建议
```json
{ "type": "equals", "source": "response.bodyJson", "path": "$.id", "expected": 1 }
```

### 步骤 3：查询该用户的文章
```http
GET /users/{{userId}}/posts
```

### 断言建议
```json
{ "type": "gt", "source": "response.bodyJson", "path": "$.length", "expected": 0 }
```

> 如果你平台里 `$.length` 对数组长度支持还不完美，就直接用 `exists` 验证第一项，例如：`$.0.id`

---

## 场景 C：提取文章 ID，再查评论

### 步骤 1
```http
GET /posts/1
```

### 提取变量
```json
{ "name": "postId", "source": "response.bodyJson", "path": "$.id" }
```

### 步骤 2
```http
GET /posts/{{postId}}/comments
```

### 断言建议
```json
{ "type": "exists", "source": "response.bodyJson", "path": "$.0.email" }
```

这个场景很适合测：
- 变量提取
- 变量引用
- 数组路径读取

---

## 场景 D：异常中断测试

### 步骤 1
```http
GET /posts/99999
```

### 步骤 2
```http
GET /users/1
```

### 测试点
- 如果 `stopOnFailure = true`
  - 第二步应被跳过
- 如果 `stopOnFailure = false`
  - 第二步应继续执行

---

## 场景 E：写接口响应验证（只测响应，不测持久化）

### 步骤 1
```http
POST /posts
```

请求体：
```json
{
  "title": "测试文章",
  "body": "这是测试内容",
  "userId": 1
}
```

### 断言
```json
{ "type": "equals", "source": "response.bodyJson", "path": "$.id", "expected": 101 }
```

```json
{ "type": "equals", "source": "response.bodyJson", "path": "$.title", "expected": "测试文章" }
```

> 不要把后续步骤写成 `GET /posts/101`，因为实测查不到。

---

## 三、适合你平台的验证点

你现在用这套接口，重点测这些：

### 1）接口基础执行是否正常
- 请求发起
- 响应解析
- 历史结果记录

### 2）变量提取与引用
- 从 `GET /posts/1` 提取 `userId`
- 在后续 `/users/{{userId}}` 里引用

### 3）断言系统
- `exists`
- `equals`
- `contains`
- `length`
- `gt/gte/lt/lte`

### 4）失败处理
- 404 是否正确显示
- stopOnFailure 是否生效

### 5）场景编排
- 多步骤串联
- 执行顺序
- 跳过逻辑
- 变量快照

---

## 四、这次修正的核心结论

### 可以依赖的
- 查询接口真实返回值
- 写接口的即时响应内容

### 不可以依赖的
- POST / PUT / PATCH / DELETE 之后的持久化状态
- 新建资源后再次 GET 一定可查到

---

## 五、推荐你现在先这样测

### 第一组：最稳妥
1. `GET /posts/1`
2. `GET /users/1`
3. `GET /posts/1/comments?_limit=2`

### 第二组：测场景能力
1. `GET /posts/1` → 提取 `userId`
2. `GET /users/{{userId}}`
3. `GET /users/{{userId}}/posts`

### 第三组：测异常路径
1. `GET /posts/99999`
2. `GET /users/1`

### 第四组：测写接口响应
1. `POST /posts`
2. `POST /comments`
3. `PUT /posts/1`
4. `PATCH /posts/1`
5. `DELETE /posts/1`

---

如果你要，我下一步可以直接再给你补一份：

**“适合 AI-Test-API 平台导入的最小 JSONPlaceholder 场景模板”**

也就是我直接按你现在这个系统的数据结构，给你一份可粘贴/可导入的接口与场景 JSON。