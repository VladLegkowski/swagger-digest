# API Digest: Swagger Petstore

> Spec: Swagger 2.0 · API version: 1.0.7 · Source: `https://petstore.swagger.io/v2/swagger.json`

## Overview

This is a sample server Petstore server. You can find out more about Swagger at [http://swagger.io](http://swagger.io) or on [irc.freenode.net, #swagger](http://swagger.io/irc/). For this sample, you can use the api key `special-key` to test the authorization filters.

- **Base URL(s):** `https://petstore.swagger.io/v2`, `http://petstore.swagger.io/v2`
- **Authentication required globally:** None explicitly required
- **Available schemes:**
  - api_key (API key in header: api_key)
  - petstore_auth (OAuth2; implicit)

## Quick index

| Method | Path | Summary | Tags |
|---|---|---|---|
| **POST** | `/pet/{petId}/uploadImage` | uploads an image | pet |
| **PUT** | `/pet` | Update an existing pet | pet |
| **POST** | `/pet` | Add a new pet to the store | pet |
| **GET** | `/pet/findByStatus` | Finds Pets by status | pet |
| **GET** | `/pet/findByTags` | Finds Pets by tags | pet |
| **GET** | `/pet/{petId}` | Find pet by ID | pet |
| **POST** | `/pet/{petId}` | Updates a pet in the store with form data | pet |
| **DELETE** | `/pet/{petId}` | Deletes a pet | pet |
| **GET** | `/store/inventory` | Returns pet inventories by status | store |
| **POST** | `/store/order` | Place an order for a pet | store |
| **GET** | `/store/order/{orderId}` | Find purchase order by ID | store |
| **DELETE** | `/store/order/{orderId}` | Delete purchase order by ID | store |
| **POST** | `/user/createWithList` | Creates list of users with given input array | user |
| **GET** | `/user/{username}` | Get user by user name | user |
| **PUT** | `/user/{username}` | Updated user | user |
| **DELETE** | `/user/{username}` | Delete user | user |
| **GET** | `/user/login` | Logs user into the system | user |
| **GET** | `/user/logout` | Logs out current logged in user session | user |
| **POST** | `/user/createWithArray` | Creates list of users with given input array | user |
| **POST** | `/user` | Create user | user |

## Endpoints

### pet

#### `POST /pet/{petId}/uploadImage`

uploads an image

**Authentication:** petstore_auth [scopes: write:pets, read:pets]

**Parameters**
- `petId` (`path`, required) · `number` — ID of pet to update
- `additionalMetadata` (`formData`) · `string` — Additional data to pass to server
- `file` (`formData`) · `string` — file to upload

**Responses**
- **200 successful operation** — `ApiResponse` (application/json)

#### `PUT /pet`

Update an existing pet

**Authentication:** petstore_auth [scopes: write:pets, read:pets]

**Parameters**
_None._

**Request body:** `application/json` → `Pet` (required)

**Responses**
- **400 Invalid ID supplied** — no body schema declared
- **404 Pet not found** — no body schema declared
- **405 Validation exception** — no body schema declared

#### `POST /pet`

Add a new pet to the store

**Authentication:** petstore_auth [scopes: write:pets, read:pets]

**Parameters**
_None._

**Request body:** `application/json` → `Pet` (required)

**Responses**
- **405 Invalid input** — no body schema declared

#### `GET /pet/findByStatus`

Finds Pets by status

Multiple status values can be provided with comma separated strings

**Authentication:** petstore_auth [scopes: write:pets, read:pets]

**Parameters**
- `status` (`query`, required) · `"available" | "pending" | "sold"[]` — Status values that need to be considered for filter

**Responses**
- **200 successful operation** — `findPetsByStatus200Response` (application/json)
- **400 Invalid status value** — no body schema declared

#### `GET /pet/findByTags`

Finds Pets by tags

Multiple tags can be provided with comma separated strings. Use tag1, tag2, tag3 for testing.

**Authentication:** petstore_auth [scopes: write:pets, read:pets]

**Parameters**
- `tags` (`query`, required) · `string[]` — Tags to filter by

**Responses**
- **200 successful operation** — `findPetsByTags200Response` (application/json)
- **400 Invalid tag value** — no body schema declared

#### `GET /pet/{petId}`

Find pet by ID

Returns a single pet

**Authentication:** api_key

**Parameters**
- `petId` (`path`, required) · `number` — ID of pet to return

**Responses**
- **200 successful operation** — `Pet` (application/json)
- **400 Invalid ID supplied** — no body schema declared
- **404 Pet not found** — no body schema declared

#### `POST /pet/{petId}`

Updates a pet in the store with form data

**Authentication:** petstore_auth [scopes: write:pets, read:pets]

**Parameters**
- `petId` (`path`, required) · `number` — ID of pet that needs to be updated
- `name` (`formData`) · `string` — Updated name of the pet
- `status` (`formData`) · `string` — Updated status of the pet

**Responses**
- **405 Invalid input** — no body schema declared

#### `DELETE /pet/{petId}`

Deletes a pet

**Authentication:** petstore_auth [scopes: write:pets, read:pets]

**Parameters**
- `api_key` (`header`) · `string`
- `petId` (`path`, required) · `number` — Pet id to delete

**Responses**
- **400 Invalid ID supplied** — no body schema declared
- **404 Pet not found** — no body schema declared
### store

#### `GET /store/inventory`

Returns pet inventories by status

Returns a map of status codes to quantities

**Authentication:** api_key

**Parameters**
_None._

**Responses**
- **200 successful operation** — `getInventory200Response` (application/json)

#### `POST /store/order`

Place an order for a pet

**Authentication:** None explicitly required

**Parameters**
_None._

**Request body:** `application/json` → `Order` (required)

**Responses**
- **200 successful operation** — `Order` (application/json)
- **400 Invalid Order** — no body schema declared

#### `GET /store/order/{orderId}`

Find purchase order by ID

For valid response try integer IDs with value >= 1 and <= 10. Other values will generated exceptions

**Authentication:** None explicitly required

**Parameters**
- `orderId` (`path`, required) · `number` — ID of pet that needs to be fetched

**Responses**
- **200 successful operation** — `Order` (application/json)
- **400 Invalid ID supplied** — no body schema declared
- **404 Order not found** — no body schema declared

#### `DELETE /store/order/{orderId}`

Delete purchase order by ID

For valid response try integer IDs with positive integer value. Negative or non-integer values will generate API errors

**Authentication:** None explicitly required

**Parameters**
- `orderId` (`path`, required) · `number` — ID of the order that needs to be deleted

**Responses**
- **400 Invalid ID supplied** — no body schema declared
- **404 Order not found** — no body schema declared
### user

#### `POST /user/createWithList`

Creates list of users with given input array

**Authentication:** None explicitly required

**Parameters**
_None._

**Request body:** `application/json` → `createUsersWithListInputRequest` (required)

**Responses**
- **default successful operation** — no body schema declared

#### `GET /user/{username}`

Get user by user name

**Authentication:** None explicitly required

**Parameters**
- `username` (`path`, required) · `string` — The name that needs to be fetched. Use user1 for testing.

**Responses**
- **200 successful operation** — `User` (application/json)
- **400 Invalid username supplied** — no body schema declared
- **404 User not found** — no body schema declared

#### `PUT /user/{username}`

Updated user

This can only be done by the logged in user.

**Authentication:** None explicitly required

**Parameters**
- `username` (`path`, required) · `string` — name that need to be updated

**Request body:** `application/json` → `User` (required)

**Responses**
- **400 Invalid user supplied** — no body schema declared
- **404 User not found** — no body schema declared

#### `DELETE /user/{username}`

Delete user

This can only be done by the logged in user.

**Authentication:** None explicitly required

**Parameters**
- `username` (`path`, required) · `string` — The name that needs to be deleted

**Responses**
- **400 Invalid username supplied** — no body schema declared
- **404 User not found** — no body schema declared

#### `GET /user/login`

Logs user into the system

**Authentication:** None explicitly required

**Parameters**
- `username` (`query`, required) · `string` — The user name for login
- `password` (`query`, required) · `string` — The password for login in clear text

**Responses**
- **200 successful operation** — `loginUser200Response` (application/json)
- **400 Invalid username/password supplied** — no body schema declared

#### `GET /user/logout`

Logs out current logged in user session

**Authentication:** None explicitly required

**Parameters**
_None._

**Responses**
- **default successful operation** — no body schema declared

#### `POST /user/createWithArray`

Creates list of users with given input array

**Authentication:** None explicitly required

**Parameters**
_None._

**Request body:** `application/json` → `createUsersWithArrayInputRequest` (required)

**Responses**
- **default successful operation** — no body schema declared

#### `POST /user`

Create user

This can only be done by the logged in user.

**Authentication:** None explicitly required

**Parameters**
_None._

**Request body:** `application/json` → `User` (required)

**Responses**
- **default successful operation** — no body schema declared

## Data types

```typescript
export interface ApiResponse {
    /** format: int32 */
    code?: number;
    type?: string;
    message?: string;
}

export interface Pet {
    /** format: int64 */
    id?: number;
    category?: Category;
    name: string;
    photoUrls: string[];
    tags?: Tag[];
    /** pet status in the store */
    status?: "available" | "pending" | "sold";
}

export type findPetsByStatus200Response = Pet[];

export type findPetsByTags200Response = Pet[];

export interface getInventory200Response {
    [key: string]: number;
}

export interface Order {
    /** format: int64 */
    id?: number;
    /** format: int64 */
    petId?: number;
    /** format: int32 */
    quantity?: number;
    /** format: date-time */
    shipDate?: string /* date-time */;
    /** Order Status */
    status?: "placed" | "approved" | "delivered";
    complete?: boolean;
}

export type createUsersWithListInputRequest = User[];

export interface User {
    /** format: int64 */
    id?: number;
    username?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    password?: string;
    phone?: string;
    /** User Status; format: int32 */
    userStatus?: number;
}

export type loginUser200Response = string;

export type createUsersWithArrayInputRequest = User[];

export interface Category {
    /** format: int64 */
    id?: number;
    name?: string;
}

export interface Tag {
    /** format: int64 */
    id?: number;
    name?: string;
}
```
