# Shopee Open Platform API v2 (open.shopee.com) — implementation notes for a Node.js integration: signing, authorization/tokens, orders (get_order_list / get_order_detail), shop & warehouses, errors/rate limits/IP whitelist

# Shopee Open Platform v2 — implementation-ready notes

Sources: official docs read directly from open.shopee.com (rendered in browser + the docs JSON endpoint `https://open.shopee.com/opservice/api/v1/doc/api/?version=2&api_name=...` and `.../developer_guide/detail?document_id=...`), cross-checked with GitHub SDKs. Items marked **[UNCERTAIN]** could not be verified against an official source.

---

## 1. Request signing

### Base string (official, guide 20 "Authorization and Authentication" and guide 16 "API calls")
Concatenate **without separators**, in this order:

| API type | Base string |
|---|---|
| Public API (e.g. `/api/v2/auth/token/get`, `/api/v2/auth/access_token/get`, `/api/v2/public/*`, `/api/v2/shop/auth_partner`) | `partner_id + api_path + timestamp` |
| Shop API (almost everything else: order, shop, logistics, product...) | `partner_id + api_path + timestamp + access_token + shop_id` |
| Merchant API (`/api/v2/merchant/*`, `/api/v2/global_product/*`, some `/api/v2/first_mile/*`) | `partner_id + api_path + timestamp + access_token + merchant_id` |

- `api_path` = the full path **without host and without query string**, including the `/api/v2` prefix, e.g. `/api/v2/order/get_order_list`. No trailing slash.
- `timestamp` = Unix epoch **seconds** (not ms).
- Official examples (docs): public `2001887/api/v2/public/get_shops_by_partner1655714431`; shop `2001887/api/v2/shop/get_shop_info165571443159777174636562737266615546704c6d14701711` (i.e. partner_id `2001887`, path, ts `1655714431`, access_token `59777174636562737266615546704c6d`, shop_id `14701711`).
- Signature: `HMAC-SHA256(key = partner_key (UTF-8 string bytes), msg = base string)` → **lowercase hex** (64 chars). Official: "The hexadecimal all-lowercase hash value is the authentication signature." Example output in docs: `56f31d01aeda9d08bf456b37f6f6640ef8614b4d6ad49baafe30b39a061f0e26`.
- The partner_key is a 64-hex-char string; use it as a plain UTF-8 string key (do NOT hex-decode it) — matches every official demo (`hmac.new(partner_key.encode(), ...)`, PHP `hash_hmac('sha256', $baseString, $partnerKey)`).

### Common (query) parameters — always in the **query string**, even for POST
| Param | Type | Notes (official descriptions) |
|---|---|---|
| `partner_id` | int | "Required for all requests." |
| `timestamp` | int (unix s) | "Required for all requests. **Expires in 5 minutes.**" |
| `sign` | string | HMAC-SHA256 hex as above |
| `access_token` | string | shop/merchant APIs only; "Valid for multiple use and expires in 4 hours." |
| `shop_id` | int | shop APIs. "Required param for most APIs." |
| `merchant_id` | int | merchant APIs. **Never send both shop_id and merchant_id** — Shopee rejects with `error_sign: Wrong sign` (SDK comment, consistent with the sign definition). |

- GET APIs: business params go in the query string alongside the common params (e.g. `order_sn_list=A,B` comma-joined, URL-encoded as `%2C`).
- POST APIs: business params go in a JSON body with `Content-Type: application/json`; common params still in the query string. (Some upload APIs use `multipart/form-data`.)

### Base URLs (official "Request Address" table on every API page, Sept 2026)
| Env | Region | Host |
|---|---|---|
| Live | Global (all markets except CN mainland & BR) | `https://partner.shopeemobile.com` |
| Live | Chinese Mainland (CNSC) | `https://openplatform.shopee.cn` |
| Live | Brazil | `https://openplatform.shopee.com.br` |
| Sandbox | Global | `https://openplatform.sandbox.test-stable.shopee.sg` |
| Sandbox | Chinese Mainland | `https://openplatform.sandbox.test-stable.shopee.cn` |

- **Legacy sandbox** `https://partner.test-stable.shopeemobile.com` still appears in the docs' JSON `test_url` field and in FAQ 121, but the current "Sandbox Testing V2" guide and Request Address tables use `openplatform.sandbox.test-stable.shopee.sg`. Prefer the new host; **[UNCERTAIN]** whether the legacy host still serves traffic.
- Live `partner_id`/key only work on live hosts; test `partner_id`/key only on sandbox (FAQ 87/125: "invalid partner_id" otherwise).
- Docs' request samples sometimes show `https://open.admin.shopee.io/...` — that is an internal host; ignore it.

### Node.js signing helper
```js
const crypto = require('crypto');

function sign({ partnerId, partnerKey, path, timestamp, accessToken, shopId, merchantId }) {
  let base = `${partnerId}${path}${timestamp}`;
  if (accessToken) base += accessToken + (merchantId ?? shopId);
  return crypto.createHmac('sha256', partnerKey).update(base).digest('hex');
}

async function shopeeRequest({ host, path, method = 'GET', partnerId, partnerKey, accessToken, shopId, params = {}, body }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const url = new URL(host + path);
  url.searchParams.set('partner_id', String(partnerId));
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', sign({ partnerId, partnerKey, path, timestamp, accessToken, shopId }));
  if (accessToken) { url.searchParams.set('access_token', accessToken); url.searchParams.set('shop_id', String(shopId)); }
  if (method === 'GET') for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();                       // always parse body; error info is in the body
  if (json.error) throw Object.assign(new Error(`${json.error}: ${json.message}`), { code: json.error, requestId: json.request_id, http: res.status });
  return json;                                          // { request_id, error:'', message:'', response:{...}, warning?:[] }
}
```

---

## 2. Authorization

### 2a. Authorization link
Two supported forms:

**(A) Legacy signed link (still supported; used in all official code demos):**
```
{host}/api/v2/shop/auth_partner?partner_id={pid}&timestamp={ts}&sign={sign}&redirect={redirect_url}
```
- `host` = live `https://partner.shopeemobile.com` or sandbox `https://openplatform.sandbox.test-stable.shopee.sg` (legacy sandbox `https://partner.test-stable.shopeemobile.com` per FAQ 121).
- `sign` = HMAC-SHA256 over `partner_id + "/api/v2/shop/auth_partner" + timestamp` (public-API form).
- Official: "The timestamp used to calculate the sign is only valid for 5 minutes. After the timestamp and the sign expire, the authorization link will no longer be valid, and you need to generate a new link." Generate the link on demand, not ahead of time.
- The `redirect` value should be URL-encoded (official demos paste it raw, but encode it to be safe).

**(B) New fixed authorization URL (official guide 20, "new method"; no sign/timestamp):**
```
https://open.shopee.com/auth?partner_id={pid}&auth_type=seller&redirect_uri={url}&response_type=code[&state={random}]
```
- Fixed URLs: Production Global `https://open.shopee.com/auth`, CN `https://open.shopee.cn/auth`, BR `https://open.shopee.com.br/auth`; Sandbox Global `https://open.sandbox.test-stable.shopee.com/auth`, CN `https://open.sandbox.test-stable.shopee.cn/auth`, BR `https://open.sandbox.test-stable.shopee.com.br/auth`. (The guide's sandbox *example* uses `https://open.test-stable.shopee.com/auth` — inconsistent with its own table; **[UNCERTAIN]** which sandbox auth host is canonical; try the table value first.)
- `auth_type`: `seller` (shop or merchant), `supplier`, `user`. `response_type` fixed `"code"`. `state` is echoed back as-is (CSRF).
- Cancel-authorization link: same params on `https://open.shopee.com/cancel_auth`.

**Redirect URL domain validation (both forms):** the domain of `redirect_uri` (or legacy `redirect`) must match the "Live Redirect URL Domain" / "Test Redirect URL Domain" configured for the App in Console once configured; otherwise error text: "The domain of redirect_uri is not consistent with the Redirect URL Domain declared in console". Not enforced while the console field is empty.

### 2b. Callback parameters Shopee appends to your redirect URL
| Param | When |
|---|---|
| `code` | always on success. "valid for only once and expires after 10 minutes." |
| `shop_id` | authorization done from a **shop account** (single shop): `https://your.redirect/?code=xxx&shop_id=123` |
| `main_account_id` | authorization done from a **main account** (multi-shop / CNSC/KRSC merchants): `https://your.redirect/?code=xxx&main_account_id=456` |
| `state` | echoed if you sent it (new link form) |

Seller picks authorization validity: 7/30/90/180/365 days or custom ≤365 days. After expiry, seller must re-authorize; check via `get_shop_info.expire_time`. Sub-accounts cannot authorize.

### 2c. GetAccessToken — `POST /api/v2/auth/token/get`  (docs name `v2.public.get_access_token`)
- Query: `partner_id`, `timestamp`, `sign` (public-API sign: `partner_id + "/api/v2/auth/token/get" + timestamp`).
- JSON body: `{ "code": "<code>", "partner_id": <int>, "shop_id": <int> }` **or** `{ "code", "partner_id", "main_account_id": <int> }` — exactly one of `shop_id`/`main_account_id`. (`partner_id` must be in **both** query and body — FAQ 138 Q5: "There is no partner_id in query".)
- Response (top-level, no `response` wrapper):
  - `access_token` (string) — "expires after 4 hours"
  - `refresh_token` (string) — "Valid for each shop_id, merchant_id, supplier_id, or user_id respectively, for 30 days."
  - `expire_in` (int) — "The validity period of the access_token, in seconds." Typically `14400` (samples also show `13859`, `14344`). One doc sample shows an epoch-like `1767001812` — **[UNCERTAIN]** whether that is a doc typo; defensively treat values > 1e9 as an absolute epoch.
  - `shop_id_list` (int[]), `merchant_id_list` (int[]) — returned when `main_account_id` was used (all shops/merchants authorized this time). `supplier_id_list`, `user_id_list`, `principal_id_list` for other auth types.
  - `request_id`, `error` (empty on success), `message`.
- Sample: `{"error":"","message":"","request_id":"f2a6...","shop_id_list":[368765100,368765098],"access_token":"6b5a...","refresh_token":"4c72...","expire_in":14400}`
- API-specific errors: `invalid_code` ("The code is expired or used or invalid"), `invalid_shop_id`, `invalid_main_acount_id` (sic, official typo).

### 2d. RefreshAccessToken — `POST /api/v2/auth/access_token/get` (docs name `v2.public.refresh_access_token`)
- Query: `partner_id`, `timestamp`, `sign` (public-API sign over `/api/v2/auth/access_token/get`). Do NOT include access_token/shop_id in the sign or query.
- JSON body: `{ "refresh_token": "...", "partner_id": <int>, "shop_id": <int> }` or with `"merchant_id"` (exactly one; each shop_id / merchant_id must be refreshed separately).
- Response (top-level): `access_token`, `refresh_token` (new), `expire_in` (`14400`), `partner_id`, `shop_id` **or** `merchant_id`, `request_id`, `error`, `message`. Sample: `{"error":"","message":"","request_id":"8308...","partner_id":2001887,"shop_id":322300222,"access_token":"7159...","refresh_token":"516c...","expire_in":14400}`
- Errors: `error_auth` "Invalid refresh_token." (already rotated / wrong shop), `refresh_token_expired` "Your refresh_token expired", `error_shop_refresh_token`, `error_merchant_refresh_token`, `shop_access_expired` "Your access to shop has expired" (authorization expired → seller must re-authorize), `shop_banned`.

### 2e. Token lifetimes and rules (official)
- `access_token`: 4 hours (`expire_in` seconds). "After a new access_token is generated, the previous access_token will remain valid for another 5 minutes."
- `refresh_token`: 30 days, **single-use**, rotated on every refresh; "The new refresh_token must be used for the next refresh request." Must be refreshed within the authorization validity period (≤365 days).
- Main-account flow: the initial access/refresh pair from GetAccessToken is shared by all shops/merchants in `shop_id_list`/`merchant_id_list`; after you call RefreshAccessToken per shop_id / merchant_id each gets its own independent pair. Store tokens **per shop_id (and per merchant_id)**.
- Recovery (FAQ 144): if you lose the new pair, re-using the same *old* refresh_token within ~4 hours returns the *same* new refresh_token; after that, use `v2.public.get_token_by_resend_code` (add `is_developer=1` to the v2 auth link; production only; resend code single-use, 10 min) or ask the seller to re-authorize.
- Practical: serialize refresh per shop (mutex), persist new pair before using it, refresh proactively ~10 min before expiry, on `error_auth: Invalid access_token` refresh once and retry.

---

## 3. Orders

### 3a. `GET /api/v2/order/get_order_list` (shop API)
Request (query):
| Param | Type | Req | Official notes |
|---|---|---|---|
| `time_range_field` | string | Y | `create_time` or `update_time` |
| `time_from` | int (unix s) | Y | "The maximum date range that may be specified with the time_from and time_to fields is 15 days." |
| `time_to` | int (unix s) | Y | must be > time_from |
| `page_size` | int | Y | "between 1 and 100" |
| `cursor` | string | N | "Specifies the starting entry of data to return"; first page: omit or `""`; then pass `next_cursor` |
| `order_status` | string | N | `UNPAID` / `READY_TO_SHIP` / `PROCESSED` / `SHIPPED` / `COMPLETED` / `IN_CANCEL` / `CANCELLED` / `INVOICE_PENDING` |
| `response_optional_fields` | string | N | only available value: `order_status` |
| `request_order_status_pending` | boolean | N | `true` → API supports `PENDING` status (orders held before READY_TO_SHIP); otherwise old logic |
| `logistics_channel_id` | int | N | BR only |

Response: `{ request_id, error, message, response: { more: boolean, next_cursor: string, order_list: [ { order_sn: string, order_status?: string, booking_sn?: string } ] } }`. Loop while `response.more === true`, passing `cursor = response.next_cursor`. API-specific error: `order.order_list_invalid_time` "Start time must be earlier than end time and diff in 15days."; `error_shop` "shopid is invalid".

### 3b. `GET /api/v2/order/get_order_detail` (shop API)
Request (query):
- `order_sn_list` (string, required): comma-joined order_sn, "limit [1,50]".
- `request_order_status_pending` (boolean, optional): `true` → supports `PENDING` and returns `pending_terms`/`pending_description`.
- `response_optional_fields` (string, optional, comma-joined). Full official list: `buyer_user_id, buyer_username, estimated_shipping_fee, recipient_address, actual_shipping_fee, goods_to_declare, note, note_update_time, item_list, pay_time, dropshipper, dropshipper_phone, split_up, buyer_cancel_reason, cancel_by, cancel_reason, actual_shipping_fee_confirmed, buyer_cpf_id, fulfillment_flag, pickup_done_time, package_list, shipping_carrier, payment_method, total_amount, invoice_data, order_chargeable_weight_gram, return_request_due_date, edt, payment_info, international_label`. "If you input an object field, all the params under it will be included automatically." FAQ 81: `item_list` (and other optional fields) are returned ONLY if requested. A practical set for an ERP: `buyer_user_id,buyer_username,recipient_address,item_list,package_list,shipping_carrier,payment_method,total_amount,pay_time,note,note_update_time,fulfillment_flag,pickup_done_time,cancel_by,cancel_reason,buyer_cancel_reason,estimated_shipping_fee,actual_shipping_fee,actual_shipping_fee_confirmed,invoice_data`.

Response: `{ request_id, error, message, warning?: string[], response: { order_list: Order[] } }`. All `timestamp` fields are **Unix seconds** (0 / null when not set, e.g. `pickup_done_time: 0`, `note_update_time: 0`, `pay_time` null when unpaid).

**Order fields** ("Return by default" = always present; others need response_optional_fields):
- `order_sn` string (default); `region` string 2-letter (default); `currency` string (default); `cod` boolean (default); `order_status` string (default); `message_to_seller` string (default); `create_time` ts (default); `update_time` ts (default; "last time that there was a change in value of order"); `days_to_ship` int32 (default; seller's DTS); `ship_by_date` ts (default; "The deadline to ship out the parcel"); `booking_sn` string (default; advance-fulfilment orders only).
- `pending_terms` string[] (`SYSTEM_PENDING`, `KYC_PENDING`, `ARRANGE_SHIPMENT_PENDING`) + `pending_description` string[] — with request_order_status_pending=true.
- `total_amount` float (only after buyer paid); `shipping_carrier` string ("logistics service provider that the buyer selected"; for BR channels 90021/90025/90026 a service_code is appended, e.g. `Entrega Turbo - M1020`); `checkout_shipping_carrier` string ("For non masking order, the logistics service provider that the buyer selected... For masking order, the logistics service type the buyer selected"); `payment_method` string; `estimated_shipping_fee` float; `actual_shipping_fee` float; `actual_shipping_fee_confirmed` boolean; `reverse_shipping_fee` float; `order_chargeable_weight_gram` int.
- `buyer_user_id` int64; `buyer_username` string (masked `****` for TW non-integrated).
- `recipient_address` object: `name`, `phone`, `town`, `district`, `city`, `state`, `region`, `zipcode`, `full_address` (all strings; may be partially masked per market, e.g. `"P******n"`), `geolocation` { `latitude`, `longitude` } (only logistics_channel_id 90026).
- `note` string (seller note), `note_update_time` ts; `pay_time` ts; `goods_to_declare` boolean (CB only); `dropshipper`, `dropshipper_phone` (ID only); `split_up` boolean; `buyer_cpf_id` (BR).
- Cancellation: `cancel_by` string ("buyer, seller, system or Ops"), `cancel_reason` string (e.g. `BACKEND_LOGISTICS_NOT_STARTED`; seller reasons `OUT_OF_STOCK`, `UNDELIVERABLE_AREA`), `buyer_cancel_reason` string (may be empty); `can_full_cancel_order` boolean, `can_partial_cancel_order` boolean, `buyer_preference_for_partial_cancellation` int (0 ship available only / 1 cancel entire order).
- `fulfillment_flag` string: `fulfilled_by_shopee` | `fulfilled_by_cb_seller` | `fulfilled_by_local_seller`. `pickup_done_time` ts.
- `invoice_data` object (BR NF-e): `number`, `series_number`, `access_key`, `issue_date` ts, `total_value`, `products_total_value`, `tax_code`, `status` (`valid`|`pending`), `pending_reason`. May be `null`, `{}` or populated.
- `payment_info` object[] (BR only): `payment_method`, `payment_processor_register`, `card_brand`, `transaction_id`, `payment_amount`.
- Misc: `return_request_due_date` ts (COMPLETED + return-eligible only), `edt_from`/`edt_to` ts (BR), `advance_package` boolean, `hot_listing_order`, `is_international` (BR), `prescription_*` (ID/PH/TH), `is_buyer_shop_collection`, `buyer_proof_of_collection`, `affiliate_sample_type` int.

**`item_list[]`** (order-level items):
`item_id` int64, `item_name` string, `item_sku` string ("parent SKU"), `model_id` int64 (0 if no variation), `model_name` string, `model_sku` string, `model_quantity_purchased` int32, `model_original_price` float, `model_discounted_price` float (0 for bundle-deal items), `wholesale` boolean, `weight` float, `add_on_deal` boolean, `main_item` boolean, `add_on_deal_id` int64, `promotion_type` string (`product_promotion`, `flash_sale`, `bundle_deal`, `add_on_deal_main`, `add_on_deal_sub`), `promotion_id` int64, `promotion_group_id` int32, `order_item_id` int64 ("For items in one same bundle deal promotion, the order_item_id should share the same id... For items not in bundle deal promotion, the order_item_id should be the same as item_id"), `line_item_id` int64 (unique per line even inside bundles), `image_info` { `image_url` }, `product_location_id` — documented as **string** ("The fulfilment warehouse ID(s) of the items in the order. (Multi-Warehouse sellers only)") but the official response sample returns an **array of strings** `"product_location_id": ["VN10XX2UZ"]` → **normalize: `Array.isArray(v) ? v : (v ? [v] : [])`**; `is_prescription_item`, `consultation_id`, `is_b2c_owned_item`, `promotion_list[]` { `promotion_type`, `promotion_id` }, `hot_listing_item`, `active_qty`, `cancel_requested_qty`, `cancelled_qty`, `return_requested_qty`, `returned_qty` (int32), `is_fulfillment_mapping`, `bundle_sku_id`, `components[]` { `parent_sku_id`, `barcode_upc`, `quantity`, `warehouse_id`, `mapping_type` } (whitelisted shops only).

**`package_list[]`**:
`package_number` string (Shopee package id, e.g. `OFG166300791210964`), `logistics_status` string (see enum below), `logistics_channel_id` int64, `shipping_carrier` string, `allow_self_design_awb` boolean, `parcel_chargeable_weight` int (sample shows `parcel_chargeable_weight_gram` — **[UNCERTAIN]** which key is actually returned; read both), `group_shipment_id` int64|null, `virtual_contact_number`, `package_query_number` (TW), `sorting_group` (TW channel 30029), and `item_list[]` with `item_id` int64, `model_id` int64, `model_quantity` int32 (note: NOT `model_quantity_purchased`), `order_item_id` int64, `promotion_group_id` int32, `product_location_id` **string** (e.g. `"IDL"`, `"VN10XX2UZ"`; "The warehouse ID of the item"). No `item_sku`/`model_sku` at package level — join to order `item_list` by `item_id`+`model_id` (or `order_item_id`).

**OrderStatus enum (official Data Definition, guide 31):** `UNPAID` (created, not paid), `PENDING` (cannot proceed to shipment arrangement yet; only with request_order_status_pending=true), `READY_TO_SHIP` (seller can arrange shipment), `PROCESSED` (shipment arranged online, tracking number obtained), `RETRY_SHIP` (3PL pickup failed, re-arrange), `SHIPPED` (dropped to / picked up by 3PL), `TO_CONFIRM_RECEIVE` (received by buyer), `IN_CANCEL` (cancellation processing), `CANCELLED`, `TO_RETURN` (return processing), `COMPLETED`. `INVOICE_PENDING` is accepted as a get_order_list filter (BR NF-e pending).

**LogisticsStatus enum (official):** `LOGISTICS_NOT_START` (initial), `LOGISTICS_PENDING_ARRANGE`, `LOGISTICS_COD_REJECTED`, `LOGISTICS_READY` (ready for fulfillment from payment perspective), `LOGISTICS_REQUEST_CREATED` (shipment arranged), `LOGISTICS_PICKUP_DONE` (handed to 3PL), `LOGISTICS_DELIVERY_DONE`, `LOGISTICS_INVALID` (cancelled at READY), `LOGISTICS_REQUEST_CANCELED` (cancelled at REQUEST_CREATED), `LOGISTICS_PICKUP_FAILED`, `LOGISTICS_PICKUP_RETRY`, `LOGISTICS_DELIVERY_FAILED`, `LOGISTICS_LOST`.

Behavioral notes (official FAQs): multi-package orders — `order_status` follows the earliest-progressing non-failed package and becomes `COMPLETED` only when all packages are `LOGISTICS_DELIVERY_DONE` (FAQ 510). `product_location_id` can change after shipping if `ship_order` is called with a non-default `address_id` (FAQ 507). `get_order_detail` returns `error_not_found` "the order is not found" for order_sn not belonging to the shop_id (FAQ 192). Buyer PII is masked in TW and some markets (FAQ 710). Under heavy load, reduce order_sn per call and increase interval (FAQ 476).

---

## 4. Shop and warehouses

### `GET /api/v2/shop/get_shop_info` (shop API, no business params)
Response is **top-level** (no `response` wrapper): `shop_name` string, `region` string (e.g. `ID`, `MY`, `TW`), `status` string (`NORMAL` | `BANNED` | `FROZEN`), `is_cb` boolean, `auth_time` ts, `expire_time` ts (authorization expiry — poll this), `is_sip` boolean, `sip_affi_shops[]` { `affi_shop_id`, `region` } (SIP primary only), `merchant_id` int64|null, `is_upgraded_cbsc` boolean, `shop_fulfillment_flag` string (`Pure - FBS Shop`, `Pure - 3PF Shop`, `PFF - FBS Shop`, `PFF - 3PF Shop`, `LFF Hybrid Shop`, `Others`, `Unknown`), `is_main_shop`, `is_direct_shop`, `linked_main_shop_id`, `linked_direct_shop_list[]` { `direct_shop_id`, `direct_shop_region` }, `is_one_awb`, `is_mart_shop`, `is_outlet_shop`, `mart_shop_id`, `outlet_shop_info_list[]` { `outlet_shop_id` }, `mart_outlet_structure_type`, plus `request_id`, `error`, `message`. Sample: `{"error":"","message":"","request_id":"e3e3...","auth_time":1741944925,"expire_time":1773503999,"shop_name":"mysipuat","region":"MY","status":"NORMAL","shop_fulfillment_flag":"Others","is_cb":false,"is_upgraded_cbsc":false,"merchant_id":null,"is_sip":true,"sip_affi_shops":[],"is_main_shop":true,"is_direct_shop":false,"linked_direct_shop_list":[{"direct_shop_id":223009454,"direct_shop_region":"SG"}],"linked_main_shop_id":0}`.

### `GET /api/v2/shop/get_warehouse_detail` (shop API)
- Definition: "For given shop id and region, return warehouse info including warehouse id, address id and location id, return all warehouse with once call."
- Query: `warehouse_type` int32 optional (1 = Pickup Warehouse, default; 2 = Return Warehouse). (Legacy sample also shows `region=ID`; not in the current param table.)
- Response: `response` is an **array**: `[ { warehouse_id: int64, warehouse_name: string, warehouse_type: int32, location_id: string, address_id: int64, region, state, city, address, zipcode, district, town, state_code: string, holiday_mode_state: int32 (0 not in holiday mode, 1 active, 2 turning off, 3 turning on) } ]`.
  - `location_id`: "Location identifier for stocks. Different location_ids represent that your addresses are in different item stocks" (sample `"IDZ"`).
  - `address_id`: "Identity of address" — this is what `ship_order` pickup uses.
- Errors: `warehouse.error_not_in_whitelist` "Your shop is not in multi-warehouse whitelist." (shop is single-warehouse → treat as "no warehouses / single location"), `warehouse.error_can_not_find_warehouse`, `warehouse.error_region_not_valid` (multi-warehouse only for ID, PH, VN, SG, TW, MX), `warehouse.error_region_can_not_blank`, `warehouse.error_shop_id_can_not_blank`. The doc's own sample response oddly contains both an error and data; in practice check `error` first.

### How `product_location_id` relates to warehouse `location_id`
- They are the **same identifier space**. `GET /api/v2/order/get_warehouse_filter_config` (multi-warehouse shops; lists warehouses with un-shipped packages) returns `warehouse_filters[] { warehouse_name, warehouse_type, product_location_id: string ("Location identifier for stocks. Different location_ids represent that your addresses are in different item stocks"), address_id, address }` — i.e. the field there is literally named `product_location_id` and carries the same description/value format as `get_warehouse_detail.location_id` (e.g. `VN001GGYZ`, `IDZ`, `IDL`).
- So: `order.item_list[].product_location_id` (array or string) and `order.package_list[].item_list[].product_location_id` (string) → look up `get_warehouse_detail` entry with `location_id === product_location_id` → gives `warehouse_id`, `warehouse_name`, `address_id`, address.
- Same `location_id` is used in product stock APIs (`stock_info_v2.seller_stock[].location_id`) and in `ship_order` pickup `address_id` selection (FAQ 507). For non-multi-warehouse shops `product_location_id` is typically empty/absent and `get_warehouse_detail` returns `warehouse.error_not_in_whitelist` — handle gracefully.

---

## 5. Rate limits, error format, pitfalls

### Response envelope (official)
```json
{ "request_id": "023c50ace933ba38473a5fb2a7dc8821", "error": "", "message": "", "response": { ... }, "warning": ["..."] }
```
- `error` empty string on success; non-empty → failure. `message` = details. `request_id` — always returned, quote it to Shopee support. `warning` string[] — partial/batch warnings.
- Token endpoints and `get_shop_info` return data at top level (no `response` key).
- Error codes are plain for common errors (`error_auth`) and **namespaced** for module errors (`order.order_list_invalid_time`, `warehouse.error_not_in_whitelist`). The docs' sample for the `error` field shows `common.error_auth` but real error samples show `error_auth`; match on suffix to be safe. SDKs also match the typo variant `invalid_acceess_token` **[UNCERTAIN]** whether Shopee still emits it.
- HTTP status: **[UNCERTAIN]** — Shopee may return non-200 (e.g. 403) for auth/sign errors; always parse the JSON body regardless of status.

### Common error codes (official "Common Error Codes" list present on every API page)
| `error` | Official message (abridged) | Handling |
|---|---|---|
| `error_auth` | "partner_id is invalid" / "Invalid access_token." / "No permission to current api" / "Invalid refresh_token." / App deleted or restricted | refresh token once & retry; if still failing → re-auth |
| `error_sign` | "Wrong sign." | fix base string/key/host env; check shop_id vs merchant_id |
| `error_param` | "Timestamp is expired" / "Invalid timestamp" / "There is no partner_id in query" / "no timestamp" / "shop_id is invalid" / "Wrong parameters, detail: {msg}." | clock sync (NTP), seconds not ms |
| `error_limit` | "The total API call number made by your APP has reached the daily API call limit, please try again after 00:00 (UTC+08:00)" | stop until 00:00 UTC+8 |
| `error_rate_limit` | "Too many requests. You have reached the rate limit. Please try again later." | exponential backoff + jitter, retry |
| `error_api_call_restricted` | API call permissions restricted for this app | stop, contact Shopee |
| `source_ip_undeclared` | "Request Source IP ({ip}) is undeclared. Please declare all your IP addresses in the Shopee Open Platform Console > App list > IP Address Whitelist" | add IP in console |
| `error_partner_key_expired` | "Your API partner key has expired, please reset the Live API Partner Key in Console" | rotate key |
| `error_api_permission` | "This app type has no permission to this API." | app type lacks module |
| `shop_no_linked` | "Partner and shop has no linked." | seller never authorized / authorization expired → re-auth |
| `shop_banned` | "The shop account has been banned..." | stop |
| `error_kyc_auth` | seller must complete Seller Registration/KYC | stop |
Per-API business errors: `error_not_found` ("Wrong parameters, detail: the order is not found."), `error_permission` ("Sorry you don't have the permission, detail: {msg}"), `error_server` ("System error. Please try again later." — retry), `error_network` ("Inner http call failed" — retry), `error_data` ("parse data failed" / "data not exist"), `error_shop` ("shopid is invalid"), `error_param` ("request not from gateway").

### Rate limits
- **No official numeric rate limits are published** in the v2 docs (each API page's `rate_limit` field is `[0,0,0]`; guides 14/16 and FAQs contain no numbers). The platform enforces a per-app **daily call quota** (`error_limit`, resets 00:00 UTC+8) and a short-window throttle (`error_rate_limit`). Third-party guides claim "10 requests/second per shop" or "100/min" — **[UNCERTAIN]/unverified**; design for backoff on `error_rate_limit` rather than a fixed budget, keep a modest concurrency (e.g. ≤5 in flight per shop), and batch (`get_order_detail` up to 50 order_sn, `page_size` 100).
- Announcement 1486 "Order Throttling" refers to orders held in `PENDING`/`ARRANGE_SHIPMENT_PENDING`, not API throttling.

### IP whitelist
- Official (guide 742 "Declare seus IPs"): "For all developers, it is mandatory to declare the application IPs and enable the IP Address Whitelist." Configured in Console > App list > (Go Live / Edit) > IP Address Whitelist > "Enable IP Address Whitelist". Once enabled, "Only declared IPs will be able to make calls to Shopee APIs" — this covers **all** APIs including public/token endpoints (`source_ip_undeclared` is listed in the common error list of `v2.public.refresh_access_token`, `get_shop_info`, order APIs, etc.). There is no per-API exemption.
- Validation rules (FAQ 186): plain IPv4 addresses only, four octets, **no CIDR** (`192.168.0.1/25` rejected), last octet not 0/255, private ranges (10/8, 172.16–31, 192.168) rejected → you need static public egress IPs (NAT gateway / fixed proxy).
- Sandbox enforcement: **[UNCERTAIN]** (docs imply whitelist is a go-live/production setting). The "90-day IP confirmation cycle" mentioned by a third-party site is **[UNCERTAIN]**.
- `v2.public.get_shopee_ip_ranges` gives Shopee's outbound IPs (for whitelisting Shopee push webhooks on your side) — the reverse direction.

### Pitfalls checklist
1. Clock skew: timestamp must be within ±5 min of Shopee's clock → run NTP; use seconds (`Math.floor(Date.now()/1000)`); `error_param: Timestamp is expired`.
2. Sign: path must be exactly `/api/v2/...` (no host, no query, no trailing slash); base string concatenated with no separators; key = partner_key as UTF-8 string; hex lowercase; use `shop_id` (not `merchant_id`) for shop APIs and never send both; use the same timestamp in the sign and the query.
3. Environment mismatch: live partner_id/key ↔ live host; test partner_id/key ↔ sandbox host (`error_auth: partner_id is invalid`). Sandbox uses `openplatform.sandbox.test-stable.shopee.sg`; legacy `partner.test-stable.shopeemobile.com` may still work but is not the documented host any more.
4. Common params go in the query even for POST; body is JSON with `Content-Type: application/json`; `partner_id` in body too for token endpoints.
5. Tokens: per-shop storage; refresh_token single-use & rotated; serialize refreshes; old access_token valid 5 min after refresh; authorization expires ≤365 days (`get_shop_info.expire_time`, error `shop_access_expired` / `shop_no_linked`).
6. Auth link (legacy) expires 5 min; `code` single-use 10 min; callback carries `shop_id` or `main_account_id` (not both); redirect domain must match Console.
7. Orders: 15-day window on `time_from/time_to`; `page_size ≤ 100`; cursor pagination via `more/next_cursor`; `order_sn_list ≤ 50`; optional fields must be requested explicitly (`item_list`, `package_list`, `recipient_address`...); `PENDING` status only with `request_order_status_pending=true`; `product_location_id` is an array at order-item level but a string at package-item level; package `item_list` uses `model_quantity`; masked PII (`****`) in TW.
8. Use `update_time` polling (not only `create_time`) to catch status changes; combine with Push (`v2.push.set_app_push_config`) for order status webhooks.
9. Retry policy: retry on `error_server`, `error_network`, `error_rate_limit` (backoff), HTTP 5xx; refresh-then-retry once on `error_auth Invalid access_token`; never retry `error_sign`, `error_param`, `error_limit` (wait for 00:00 UTC+8), `source_ip_undeclared`, `shop_no_linked`, `shop_banned`.


## Uncertainties
- Rate-limit numbers: Shopee publishes no numeric per-second/per-minute limits in the v2 docs (rate_limit field is [0,0,0]); only error_rate_limit (short window) and error_limit (daily, resets 00:00 UTC+8) exist. Third-party claims (10 rps/shop, 100/min) are unverified.
- Legacy sandbox host https://partner.test-stable.shopeemobile.com still appears in the docs JSON test_url and FAQ 121, but current Request Address tables and the Sandbox Testing V2 guide use https://openplatform.sandbox.test-stable.shopee.sg — unclear whether the legacy host still serves traffic.
- Sandbox authorization host: guide table says https://open.sandbox.test-stable.shopee.com/auth while the guide's own example uses https://open.test-stable.shopee.com/auth.
- Whether the IP whitelist is enforced in sandbox, and the '90-day IP re-confirmation cycle' claim (third-party source only).
- HTTP status codes accompanying error responses (e.g. 403 for error_sign/error_auth) are not documented; always parse the JSON body.
- get_access_token doc sample shows expire_in as an epoch-like value (1767001812) while the description says seconds (14400 elsewhere); treat values > 1e9 defensively as absolute epoch.
- package_list weight key: parameter table says parcel_chargeable_weight but the response sample shows parcel_chargeable_weight_gram.
- Whether Shopee still emits the typo error code invalid_acceess_token (SDKs match it) and whether common errors ever come prefixed as common.error_auth (doc sample) vs error_auth (error samples).
- product_location_id at order item level is documented as string but returned as an array in the official sample; normalize both.

## Sources
- https://open.shopee.com/developer-guide/20 (Authorization and Authentication, last updated 2026-07-24; read via browser)
- https://open.shopee.com/opservice/api/v1/developer_guide/detail?document_id=16&language_code=en (API calls: domains, common params, sign)
- https://open.shopee.com/opservice/api/v1/developer_guide/detail?document_id=31&language_code=en (V2.0 Data Definition: OrderStatus, LogisticsStatus)
- https://open.shopee.com/opservice/api/v1/developer_guide/detail?document_id=644&language_code=en (Sandbox Testing V2)
- https://open.shopee.com/opservice/api/v1/developer_guide/detail?document_id=742&language_code=en (IP Address Whitelist guide)
- https://open.shopee.com/opservice/api/v1/developer_guide/detail?document_id=14&language_code=en (App management)
- https://open.shopee.com/documents/v2/v2.order.get_order_detail?module=94&type=1 (rendered in browser, full field list + Request Address table)
- https://open.shopee.com/opservice/api/v1/doc/api/?version=2&api_name=v2.order.get_order_detail
- https://open.shopee.com/opservice/api/v1/doc/api/?version=2&api_name=v2.order.get_order_list
- https://open.shopee.com/opservice/api/v1/doc/api/?version=2&api_name=v2.shop.get_shop_info
- https://open.shopee.com/opservice/api/v1/doc/api/?version=2&api_name=v2.shop.get_warehouse_detail
- https://open.shopee.com/opservice/api/v1/doc/api/?version=2&api_name=v2.order.get_warehouse_filter_config
- https://open.shopee.com/opservice/api/v1/doc/api/?version=2&api_name=v2.public.get_access_token
- https://open.shopee.com/opservice/api/v1/doc/api/?version=2&api_name=v2.public.refresh_access_token
- https://open.shopee.com/opservice/api/v1/portal_faq/detail?faq_id=138&language_code=en (token error meanings)
- https://open.shopee.com/opservice/api/v1/portal_faq/detail?faq_id=144&language_code=en (lost refresh_token backup plan)
- https://open.shopee.com/opservice/api/v1/portal_faq/detail?faq_id=507&language_code=en (product_location_id changes after shipping)
- https://open.shopee.com/opservice/api/v1/portal_faq/detail?faq_id=510&language_code=en (multi-package order_status)
- https://open.shopee.com/opservice/api/v1/portal_faq/detail?faq_id=476&language_code=en (large volume advice)
- https://open.shopee.com/opservice/api/v1/portal_faq/list?category_id=2015 / 2017 / 2022 / 2031 / 2013 (FAQ lists: auth flow, live auth issues, sandbox, orders, IP validation FAQ 186)
- https://context7.com/websites/open_shopee_developer-guide/llms.txt (mirror of official sign examples)
- https://github.com/congminh1254/shopee-sdk (src/fetch.ts, src/utils/signature.ts, src/schemas/order.ts, src/schemas/shop.ts, src/schemas/region.ts, src/managers/auth.manager.ts)
- https://github.com/QuoVadis86/shopee-sdk (sign.go, client.go, partner.go, error.go, shop.go)
- https://github.com/passwind/go-shopee-v2/blob/main/order.go
- https://github.com/sulistta/shopee-js
- https://github.com/Hinten/next_erp/pull/1490 and https://github.com/Hinten/next_erp/issues/1522 (common error list, error_limit reset, IP whitelist behaviour)
- https://deo.shopeemobile.com/shopee/cms_cdn_bucket/ecb708f5284142ceb68be4a84f6cf5a4_TH_SEH_Open%20API_Developer%20Guide_v2.1_20220722.pdf (official TH developer guide, 2022)
- https://developer.inlinex.com.sg/blog/shopee-api-integration-guide-sellers (third-party; unverified 10 rps claim)
- https://publicapis.io/shopee-api (third-party; unverified 90-day IP cycle claim)
