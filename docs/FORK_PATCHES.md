# Nhật ký patch Kroki fork

Tài liệu này ghi các thay đổi dành riêng cho nền tảng Diagram as Code trong phần Kroki fork. Mỗi patch phải nhỏ, có test gần module bị sửa và được đánh giá lại khi đồng bộ phiên bản upstream.

| ID | Khu vực | Thay đổi và lý do | Kiểm thử | Upstream / chiến lược rebase |
|---|---|---|---|---|
| KFP-001 | `server/action/Delegator` | Thêm deadline cấu hình `KROKI_DELEGATE_TIMEOUT_MS` để companion treo không giữ request vô hạn. | `DelegatorTest.should_cancel_a_wedged_companion_request_at_configured_timeout` | Chưa có upstream reference; khi rebase, bỏ patch nếu upstream đã có request timeout tương đương và giữ test hồi quy. |
| KFP-002 | `server/action/Commander` | Khi timeout, lỗi ghi stdin hoặc thread bị interrupt, force-kill descendants, giữ parent shell sống đủ để reap child rồi mới force-kill parent nếu cần. Mục tiêu là không để Graphviz/D2 process hoặc zombie rò. | `CommanderTest.should_kill_process_tree_after_timeout` chạy ba vòng và xác nhận từng child PID đã dừng; toàn bộ `CommanderTest` | Candidate để upstream; khi rebase, ưu tiên API cleanup của upstream nếu thu hồi cả process tree và vẫn pass test. |
| KFP-003 | `server/action/Delegator` | Không ghép `stacktrace` do companion trả về vào `BadRequestException`; chỉ giữ tên lỗi và message để tránh lộ path/implementation detail. | `DelegatorTest.should_not_propagate_companion_stack_trace` | Candidate để upstream; giữ patch đến khi upstream có structured error không chứa stack production. |
| KFP-004 | `server/ops/docker/Dockerfile` | Cài `wget` thành layer riêng sau TeX Live để runtime có công cụ tải renderer mà không làm mất cache của layer package lớn khi đồng bộ fork. | Docker Bake parse và `CI / test-containers` image build/smoke | Giữ package runtime tối thiểu; khi upstream đã cài công cụ tải tương đương thì bỏ layer riêng. |
| KFP-005 | `server/ops/docker/Dockerfile` | Các Node SEA builder dùng lockfile qua `npm ci --include=optional`; normalize CRLF của JavaScript trong build context trước Biome để clean build nhất quán trên Windows/Linux và luôn cài native Biome binary. | Buildx Bake `kroki` và `kroki-mermaid` từ clean checkout, sau đó chạy Product Compose acceptance | Candidate upstream; giữ đến khi upstream builder dùng deterministic install và không phụ thuộc line ending host. |

## Quy trình đồng bộ upstream

1. Rebase hoặc merge upstream vào branch tích hợp riêng và chạy test upstream trước khi áp dụng lại patch.
2. Đối chiếu từng ID trong bảng; đánh dấu patch đã được upstream thay thế thay vì áp dụng trùng.
3. Chạy Maven test Java 25, Product CI và renderer acceptance Compose.
4. Cập nhật ID, upstream issue/PR và changelog nếu behavior hoặc renderer version thay đổi.

Không đưa auth, rate limit, tenant cache hoặc GitHub policy vào nhật ký này vì các trách nhiệm đó thuộc Diagram Gateway.
