# Diagram as Code GitHub Action

Action gọi Diagram Gateway để kiểm tra hoặc sinh lại SVG/PNG từ source được khai báo trong `.diagram.yml`. Bundle `dist/index.cjs` đã chứa dependency nên repository sử dụng chỉ cần checkout source và gọi Action.

## Thiết lập check cho pull request

```yaml
name: Diagram check

on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  diagrams:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: hnamkk/MyKroki/product/github-action@main
        with:
          gateway-url: ${{ vars.DIAGRAM_GATEWAY_URL }}
          auth-mode: oidc
          oidc-audience: diagram-gateway
```

`fetch-depth: 0` cho phép Action so sánh với base commit của pull request. `id-token: write` chỉ cho phép job xin JWT từ GitHub, không cấp quyền ghi repository. `oidc-audience` phải trùng `GITHUB_OIDC_AUDIENCE` của Gateway; Gateway phải allowlist immutable repository ID và workflow ref. Nếu Gateway chạy trong mạng riêng, dùng self-hosted runner có thể kết nối tới Gateway.

Action mặc định chạy `check`, chỉ có quyền repository `contents: read`, không ghi file, không commit và không post comment. OIDC bổ sung `id-token: write` chỉ để xin identity token. Action upload artifact `diagram-previews` chứa output render và `manifest.json`, đồng thời fail khi source lỗi hoặc generated output bị thiếu, stale hay orphaned.

## Generate trên event đáng tin cậy

```yaml
name: Generate diagrams

on:
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  generate:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v6
      - uses: hnamkk/MyKroki/product/github-action@main
        with:
          gateway-url: ${{ vars.DIAGRAM_GATEWAY_URL }}
          auth-mode: oidc
          oidc-audience: diagram-gateway
          mode: generate
          changed-only: "false"
      - uses: actions/upload-artifact@v6
        with:
          name: generated-workspace
          path: docs/generated
```

`generate` chỉ được chạy trên `push` hoặc `workflow_dispatch`; Action từ chối mọi `pull_request` event. Tất cả diagram được render thành công trước khi workspace thay đổi, file được ghi atomically và rollback khi transaction lỗi. Action không tự commit; bước commit/push phải được thiết kế riêng với `contents: write` trên trusted branch.

## Inputs và outputs

| Input | Mặc định | Mô tả |
|---|---|---|
| `gateway-url` | bắt buộc | Base URL HTTP(S) của Gateway, không được chứa credential. |
| `api-key` | rỗng | API key từ GitHub Secret; được mask ngay khi Action bắt đầu. |
| `auth-mode` | `auto` | `auto`, `oidc`, `api-key` hoặc `none`. `auto` ưu tiên OIDC khi có audience và chỉ fallback khi API key được cấu hình. |
| `oidc-audience` | rỗng | Custom audience xin từ GitHub và được Gateway xác minh. Bắt buộc với `auth-mode: oidc`. |
| `config-path` | `.diagram.yml` | Đường dẫn tương đối trong repository. |
| `mode` | `check` | `check` hoặc `generate`. |
| `changed-only` | `true` | Chỉ áp dụng trên PR; config/lock đổi sẽ tự full render. |
| `artifact-name` | `diagram-previews` | Tên artifact chứa preview và manifest an toàn. |
| `fail-on-stale` | `true` | Có fail `check` khi phát hiện output drift hay không. |

Action trả `checked-count`, `stale-count` và `generated-count`. Lỗi Gateway 400/401/403/422/429/503/504 được phân loại riêng; annotation dùng file, line, column, `requestId` và `Retry-After` khi Gateway cung cấp.

## Public, private và fork repository

- Public và private repository dùng cùng OIDC policy theo immutable `repository_id`; rename repository không làm đổi danh tính được allowlist.
- Pull request cùng repository hoặc từ fork chạy read-only với `contents: read` và xin JWT bằng `id-token: write`; không cần repository secret hay PAT.
- Gateway giới hạn workflow, event và ref riêng cho `pull_request`, `push`, `workflow_dispatch`. Policy không cho phép event sẽ nhận 403.
- Không dùng `pull_request_target` để checkout rồi thực thi code chưa tin cậy nhằm lấy secret.
- `generate` vẫn bị cấm trên pull request kể cả OIDC hợp lệ. OIDC chỉ cấp scope render, không trao quyền commit/push.

## API key fallback và local no-auth

Gateway cũ hoặc deployment chưa bật OIDC có thể dùng:

```yaml
      - uses: hnamkk/MyKroki/product/github-action@main
        with:
          gateway-url: ${{ vars.DIAGRAM_GATEWAY_URL }}
          auth-mode: api-key
          api-key: ${{ secrets.DIAGRAM_API_KEY }}
```

`auth-mode: auto` dùng OIDC khi có `oidc-audience`; nếu GitHub không cấp token và `api-key` cũng được truyền, Action cảnh báo rồi fallback. `auth-mode: oidc` là strict và không fallback. Chỉ dùng `none` với Gateway local đã cấu hình no-auth.
