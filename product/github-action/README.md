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
          api-key: ${{ secrets.DIAGRAM_API_KEY }}
```

`fetch-depth: 0` cho phép Action so sánh với base commit của pull request. Nếu Gateway chạy trong mạng riêng, dùng self-hosted runner có thể kết nối tới Gateway. Với Gateway local không bật auth có thể bỏ `api-key`; Gateway hosted dùng API key lưu trong GitHub Actions Secret.

Action mặc định chạy `check`, chỉ cần `contents: read`, không ghi file, không commit và không post comment. Nó upload artifact `diagram-previews` chứa output render và `manifest.json`, đồng thời fail khi source lỗi hoặc generated output bị thiếu, stale hay orphaned.

## Generate trên event đáng tin cậy

```yaml
name: Generate diagrams

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  generate:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v6
      - uses: hnamkk/MyKroki/product/github-action@main
        with:
          gateway-url: ${{ vars.DIAGRAM_GATEWAY_URL }}
          api-key: ${{ secrets.DIAGRAM_API_KEY }}
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
| `config-path` | `.diagram.yml` | Đường dẫn tương đối trong repository. |
| `mode` | `check` | `check` hoặc `generate`. |
| `changed-only` | `true` | Chỉ áp dụng trên PR; config/lock đổi sẽ tự full render. |
| `artifact-name` | `diagram-previews` | Tên artifact chứa preview và manifest an toàn. |
| `fail-on-stale` | `true` | Có fail `check` khi phát hiện output drift hay không. |

Action trả `checked-count`, `stale-count` và `generated-count`. Lỗi Gateway 400/401/403/422/429/503/504 được phân loại riêng; annotation dùng file, line, column, `requestId` và `Retry-After` khi Gateway cung cấp.

## Public, private và fork repository

- Repository private dùng `DIAGRAM_API_KEY` trong Actions Secret; không đặt key trong `.diagram.yml`, workflow, variable hay artifact.
- Pull request cùng repository nhận secret theo policy GitHub và chạy read-only với `contents: read`.
- Pull request từ fork không nhận repository secret. Khi Gateway yêu cầu API key, job sẽ fail auth rõ ràng; có thể skip job fork và cho maintainer chạy `workflow_dispatch` sau khi review.
- Không dùng `pull_request_target` để checkout rồi thực thi code chưa tin cậy nhằm lấy secret.
- OIDC không secret là phase kế tiếp; Phase 3 chỉ hỗ trợ API key hoặc Gateway local no-auth.
