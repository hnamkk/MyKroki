# Pilot Repository Fixture

Fixture này mô phỏng repository sử dụng MVP với Mermaid, C4-PlantUML, Graphviz và D2. Source trong `diagrams/` là dữ liệu gốc; SVG trong `generated/` là artifact có thể tái tạo.

## Dùng fixture

1. Copy toàn bộ nội dung thư mục này vào repository pilot.
2. Đổi `runs-on` nếu GitHub-hosted runner truy cập được Gateway; giữ self-hosted runner khi Gateway ở mạng riêng.
3. Đặt repository variable `DIAGRAM_GATEWAY_URL`.
4. Allowlist repository ID và workflow ref trong policy OIDC của Gateway.
5. Generate lần đầu bằng VS Code Extension hoặc Action ở `mode: generate` trên `workflow_dispatch`, rồi commit SVG.
6. Mở pull request sửa một source và xác nhận Diagram check phát hiện output stale.

Không đổi Action sang `@main` trong pilot/release. Tag `product-v0.1.0` khóa Action bundle cùng version Gateway và renderer.
