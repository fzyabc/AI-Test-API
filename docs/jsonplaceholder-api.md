# JSONPlaceholder 测试接口文档

## 概述

- **BASE_URL**: `https://jsonplaceholder.typicode.com`
- **无需认证**：所有接口都是公开的，不需要 token / API key
- **用途**：用于验证 AI-Test-API 平台的场景编排、变量提取、断言等能力

> ⚠️ 注意：POST / PUT / PATCH / DELETE 操作不真正修改数据，只返回模拟响应。

---

## 1. 查询文章列表

```http
GET /posts
GET /posts?userId=1
GET /posts?userId=1&_limit=3
```

### 返回结构

```json
[
  {
    "userId": 1,
    "id": 1,
    "title": "文章标题",
    "body": "文章内容"
  }
]
```

### 重点看

- 分页 / 过滤参数 `_limit` 是否生效
- 返回条数是否正确
- 字段结构是否稳定

---

## 2. 查询单篇文章

```http
GET /posts/1
GET /posts/99999
```

### 重点看

- `/posts/1` 正常返回
- `/posts/99999` 返回 404（用来测异常断言）

---

## 3. 查询某用户的文章

```http
GET /users/1/posts
```

### 返回结构

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

### 重点看

- 返回的文章 `userId` 是否都是 `1`

---

## 4. 查询评论

```http
GET /posts/1/comments
GET /comments?postId=1
```

### 返回结构

```json
[
  {
    "postId": 1,
    "id": 1,
    "name": "评论者",
    "email": "test@example.com",
    "body": "评论内容"
  }
]
```

### 重点看

- 评论是否属于对应文章
- `email` 格式是否正确

---

## 5. 查询用户信息

```http
GET /users/1
```

### 返回结构

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

### 重点看

- 嵌套结构是否都能正常解析
- 地址 / 公司信息是嵌套对象

---

## 6. 创建文章 (POST)

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

### 返回结构

```json
{
  "title": "测试文章",
  "body": "这是测试内容",
  "userId": 1,
  "id": 101
}
```

### 重点看

- **返回的 `id` 是 101**（这个接口不真正写入数据库，只是返回模拟 id）
- 请求体字段原样返回
- 这用来测变量提取：提取 `$.id` 供后续步骤使用

---

## 7. 创建评论 (POST)

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

### 重点看

- 返回的 `id` 是 501
- `postId` 是否和请求一致

---

## 8. 创建用户 (POST)

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

### 重点看

- 返回的 `id` 是 11

---

## 9. 更新文章 (PUT)

```http
PUT /posts/1
Content-Type: application/json
```

### 请求体

```json
{
  "title": "更新后的标题",
  "body": "更新后的内容",
  "userId": 1
}
```

### 重点看

- 返回完整对象
- `id` 仍是 1

---

## 10. 部分更新文章 (PATCH)

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

### 重点看

- 只传了 `title`
- 其他字段也在返回中（模拟全量返回）

---

## 11. 删除文章 (DELETE)

```http
DELETE /posts/1
```

### 重点看

- 返回空对象 `{}`
- HTTP 状态码 200

---

# 测试场景建议

## 场景一：基础查询

| 步骤 | 接口 | 说明 |
|------|------|------|
| 1 | `GET /users/1` | 验证基本请求和响应解析 |

**检查点**：
- 响应状态码 200
- 返回数据包含 `id`, `name`, `email`
- `address.geo.lat` 嵌套字段存在

---

## 场景二：创建 → 提取变量 → 查询

| 步骤 | 接口 | 说明 |
|------|------|------|
| 1 | `POST /posts` | 创建文章 |
| 2 | `GET /posts/{{newPostId}}` | 查询刚创建的文章 |

### 步骤 1：创建文章

- **接口**: `POST /posts`
- **请求体**:
  ```json
  {
    "title": "场景测试文章",
    "body": "场景测试内容",
    "userId": 1
  }
  ```
- **提取变量**:
  ```json
  { "name": "newPostId", "source": "response.bodyJson", "path": "$.id" }
  ```
- **断言**:
  ```json
  { "type": "exists", "source": "response.bodyJson", "path": "$.id" }
  ```

### 步骤 2：查询文章

- **接口**: `GET /posts/{{newPostId}}`
- **请求路径参数**:
  ```json
  { "id": "{{newPostId}}" }
  ```
- **断言**:
  ```json
  { "type": "exists", "source": "response.bodyJson", "path": "$.title" }
  ```

**检查点**：
- 步骤 1 能成功提取 `newPostId`
- 步骤 2 能正确使用 `{{newPostId}}` 发出请求
- 两个步骤都通过断言

---

## 场景三：多步链路

| 步骤 | 接口 | 说明 |
|------|------|------|
| 1 | `POST /posts` | 创建文章，提取 id |
| 2 | `GET /posts/{{postId}}/comments` | 查询该文章的评论 |

### 步骤 1：创建文章

- **接口**: `POST /posts`
- **请求体**:
  ```json
  {
    "title": "多步测试",
    "body": "多步测试内容",
    "userId": 1
  }
  ```
- **提取变量**:
  ```json
  { "name": "postId", "source": "response.bodyJson", "path": "$.id" }
  ```
- **断言**:
  ```json
  { "type": "exists", "source": "response.bodyJson", "path": "$.id" }
  ```

### 步骤 2：查询评论

- **接口**: `GET /posts/{{postId}}/comments`
- **断言**:
  ```json
  { "type": "exists", "source": "response.bodyJson", "path": "$.id" }
  ```

**检查点**：
- 变量正确传递
- 评论列表返回正常（空列表也正常）

---

## 场景四：异常处理测试

| 步骤 | 接口 | 说明 |
|------|------|------|
| 1 | `GET /posts/99999` | 查询不存在文章，预期失败 |
| 2 | `GET /posts/1` | 查询正常文章，验证 stopOnFailure |

**检查点**：
- 步骤 1 应该失败（404）
- 如果 `stopOnFailure: true`，步骤 2 应该被跳过
- 如果 `stopOnFailure: false`，步骤 2 应该正常执行

---

# 断言类型速查表

| 类型 | 说明 | 示例 |
|------|------|------|
| `exists` | 字段存在 | `$.data.id` |
| `equals` | 值相等 | `$.id` 等于 `101` |
| `contains` | 包含文本 | `$.title` 包含 `"测试"` |
| `notEmpty` | 不为空 | `$.data.list` 数组非空 |
| `regex` | 正则匹配 | `$.email` 匹配 `^Sincere@` |
| `length` | 长度等于 | `$.data` 数组长度等于 `10` |
| `gt` | 大于 | `$.count` > `0` |
| `gte` | 大于等于 | `$.count` >= `0` |
| `lt` | 小于 | `$.count` < `100` |
| `lte` | 小于等于 | `$.count` <= `100` |

---

# 你测的时候重点看这几个东西

### 1）基本通不通
- 请求发出去能不能拿到正常响应
- 响应数据能不能正常解析

### 2）变量提取和引用
- 步骤1 创建文章后，能不能提取 `$.id`
- 步骤2 能不能用 `{{newPostId}}` 拿到这个值
- 这是场景编排能力最核心的验证点

### 3）断言
- 用 `exists` 断言字段存在
- 用 `equals` 断言某个值
- 用 `length` 断言数组长度
- 用 `contains` 断言文本包含

### 4）异常处理
- 查 `/posts/99999`（不存在），看你的平台怎么处理失败
- 失败后下一步是否按 `stopOnFailure` 设置正确处理

### 5）历史记录
- 场景执行后，是否能在运行历史里看到
- 能否看到每一步的明细
