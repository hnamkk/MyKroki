# Infrastructure and Operations

## Khởi động

```powershell
cd D:\MyKroki\product\deploy
Copy-Item .env.example .env
# Tạo key và chép verifier record vào DIAGRAM_API_KEY_RECORDS trong .env.
npm run key:generate --prefix .. -- local-admin
docker compose up -d --build
$env:DIAGRAM_API_KEY = "key-plaintext-vừa-tạo"
npm --prefix .. run smoke
```

Kiểm tra `http://localhost:9000/health/live` cho tiến trình Gateway và `/health/ready` cho cả đường kết nối tới Kroki. Gateway nối cả mạng `edge` và mạng `rendering`; Kroki và Mermaid chỉ nối mạng `rendering` internal và không publish port ra host.

## TLS và mạng

Đặt Gateway sau reverse proxy có HTTPS khi dùng ngoài localhost. Chỉ cho runner, VPN hoặc mạng công ty truy cập. Không expose trực tiếp Kroki/Mermaid. Giữ `AUTH_MODE=required`; `disabled` chỉ dành cho local cô lập.

## Vận hành thường ngày

- Xem trạng thái: `docker compose ps`.
- Xem log: `docker compose logs -f --tail=200 gateway kroki mermaid`.
- Cập nhật cả ba image pin trong `.env`, chạy `docker compose pull` rồi `docker compose up -d`.
- Smoke test sau mỗi lần deploy bằng `npm --prefix .. run smoke`.
- Rollback bằng cách trả cả Gateway, Kroki và Mermaid về cùng product version/digest cũ rồi chạy lại Compose.

Gateway MVP không có database hay volume dữ liệu. Cache nằm trong RAM và mất khi restart; source và SVG chuẩn vẫn nằm trong Git. Cache mặc định có TTL 24 giờ, tổng trọng lượng tối đa 256 MiB và chỉ lưu từng output không quá 5 MiB. Điều chỉnh lần lượt bằng `CACHE_TTL_MS`, `CACHE_MAX_BYTES` và `CACHE_MAX_ITEM_BYTES`; `CACHE_MAX_ENTRIES` vẫn là chặn bổ sung theo số entry.

Backup cấu hình vận hành gồm `.env` được mã hóa/bảo vệ, API-key verifier records, OIDC repository policy, reverse-proxy/TLS config, release `manifest.json` và `SHA256SUMS`. Không backup plaintext API key vào Git. Giữ tối thiểu env/manifest của version đang chạy và version ổn định ngay trước đó để rollback.

Reference Compose chạy cả ba service bằng non-root user, read-only root filesystem, `cap_drop: ALL`, `no-new-privileges` và restart policy. Các giới hạn mặc định:

| Service | CPU | Memory | PID |
|---|---:|---:|---:|
| Gateway | 1.0 | 512 MiB | 256 |
| Kroki | 2.0 | 1 GiB | 256 |
| Mermaid | 1.0 | 1 GiB | 256 |

Điều chỉnh bằng các biến `GATEWAY_*_LIMIT`, `KROKI_*_LIMIT` và `MERMAID_*_LIMIT` trong `.env`; chỉ tăng sau khi benchmark trên host đích.

## Cấp, xoay và thu hồi API key

Gateway đọc `DIAGRAM_API_KEY_RECORDS` dưới dạng JSON. Mỗi record có `id`, SHA-256 `verifier`, `scopes`, `cachePartition` và `status` (`active` hoặc `revoked`). Gateway không lưu plaintext key. Lệnh sau in plaintext đúng một lần cùng record để lưu ở phía Gateway:

```powershell
npm run key:generate --prefix .. -- repo-ci
```

Khi cấp key, lưu plaintext vào VS Code SecretStorage hoặc GitHub Secret; chỉ đưa verifier record vào secret/config gắn cho Gateway. Để xoay key mà không làm đổi cache partition, thêm record mới với cùng `cachePartition`, restart Gateway, cập nhật client, xác nhận render thành công, rồi chuyển record cũ sang `revoked` và restart lần nữa. Sau thời gian kiểm tra có thể xóa record revoked.

`DIAGRAM_API_KEYS` dạng plaintext chỉ còn để tương thích cấu hình cũ và không nên dùng cho deployment mới. Không có admin API trong MVP; thay đổi lifecycle là thao tác có kiểm soát trên mounted secret/config.

## GitHub OIDC và repository policy

Bật `GITHUB_OIDC_ENABLED=true`, đặt custom `GITHUB_OIDC_AUDIENCE`, rồi cấu hình `GITHUB_OIDC_REPOSITORY_POLICIES` dưới dạng JSON. Gateway có thể chạy OIDC-only với `DIAGRAM_API_KEY_RECORDS` rỗng.

```json
[
  {
    "repositoryId": "123456789",
    "workflowRefs": [
      "owner/repository/.github/workflows/diagram-check.yml@refs/*"
    ],
    "events": {
      "pull_request": {
        "refs": ["refs/pull/*"],
        "baseRefs": ["main"]
      },
      "push": {
        "refs": ["refs/heads/main"]
      },
      "workflow_dispatch": {
        "refs": ["refs/heads/main"]
      }
    }
  }
]
```

Chỉ một wildcard ở cuối pattern được hỗ trợ. Quyền được gắn với immutable `repositoryId`; tên repository trong workflow ref chỉ giới hạn file workflow, không thay thế repository ID. Đặt `status: "revoked"` để thu hồi policy. `pull_request_target` không được hỗ trợ. Action phải có `id-token: write`, dùng `auth-mode: oidc` và audience trùng Gateway.

Gateway mặc định tin issuer/JWKS chính thức của GitHub. Các biến `GITHUB_OIDC_ISSUER`, `GITHUB_OIDC_JWKS_URL`, clock tolerance, cache age, cooldown và timeout chỉ nên đổi cho trust domain được kiểm soát. Khi JWKS tạm lỗi, key đã cache vẫn hoạt động; token dùng key chưa cache nhận 503 và `Retry-After`.

## Giám sát tối thiểu

Theo dõi HTTP 5xx, thời gian render, memory/container restart, bulkhead queue và cache hit/miss tại `/metrics`. Endpoint metrics chỉ tồn tại khi `METRICS_ENABLED=true`; khi Gateway truy cập được từ Internet, reverse proxy phải giới hạn endpoint này cho mạng vận hành. Cảnh báo khi `/health/ready` lỗi liên tục trên 2 phút. LRU, single-flight và token bucket chỉ có hiệu lực trong từng Gateway replica; MVP nên bắt đầu với một replica.

Các giới hạn mặc định là source 1 MiB, output 10 MiB, cache 256 MiB/5 MiB mỗi item/TTL 24 giờ, timeout 15 giây, 4 render đồng thời và queue 20 request. Gateway fail fast nếu giá trị nằm ngoài khoảng an toàn, cache item limit lớn hơn tổng cache limit hoặc production bật no-auth trên địa chỉ non-loopback.

## Quality gate vận hành

Sau thay đổi image hoặc cấu hình tài nguyên, chạy smoke/renderer acceptance trước, rồi chạy:

```powershell
$env:DIAGRAM_GATEWAY_URL = "http://localhost:9000"
$env:DIAGRAM_API_KEY = "<plaintext-test-key>"
npm --prefix .. run test:security
npm --prefix .. run test:performance
npm --prefix .. run test:soak
npm --prefix .. run test:container-policy
```

Để diễn tập recovery, dừng Mermaid và chạy `test:recovery` với `RECOVERY_EXPECT=degraded`; khởi động lại service rồi chạy với `RECOVERY_EXPECT=ready`. Readiness phải tự trở về 200, không sửa cache hay restart Gateway thủ công.

## Upgrade và rollback

Release Compose yêu cầu `GATEWAY_IMAGE`, `KROKI_IMAGE` và `MERMAID_IMAGE`; không có fallback sang image upstream. Tagged release ghi ba reference cùng product version và ưu tiên digest vào env artifact.

1. Lưu `.env.product-v<old>` và `.env.product-v<new>`.
2. Xác minh `SHA256SUMS` và manifest của version mới.
3. Pull/up version mới, chờ readiness, chạy smoke và renderer acceptance.
4. Nếu fail, khôi phục toàn bộ ba image từ env cũ; không trộn Gateway mới với renderer cũ ngoài một compatibility test có chủ đích.
5. Ghi người thực hiện, thời gian, health/smoke result và rollback owner vào biên bản go/no-go.

Chi tiết lệnh và acceptance matrix nằm tại [`docs/E2E_SETUP_GUIDE.md`](../../docs/E2E_SETUP_GUIDE.md).
