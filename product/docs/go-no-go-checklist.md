# MVP Go/No-Go Checklist

## Quyết định hiện tại

**Conditional Go cho pilot; chưa Go cho release tag.**

Implementation Phase 1-7 đã có thể chạy và kiểm thử local. Release tag chỉ được tạo sau khi hoàn tất các bằng chứng môi trường ngoài ở cuối bảng.

## Quality gates

| Gate | Trạng thái | Bằng chứng/điều kiện |
|---|---|---|
| Gateway contract, auth, rate, cache, sanitizer, bulkhead | Ready | Product unit/integration và OpenAPI contract |
| Bốn renderer MVP | Ready | Compose renderer acceptance và pilot fixture |
| GitHub Action check/generate | Ready | Unit/integration và Compose E2E |
| VS Code Extension | Ready | Unit, Extension Host matrix và Gateway smoke |
| OIDC repository policy | Ready | Public/private/fork policy tests |
| Reliability/security/performance | Ready locally | Security, performance, soak, recovery, determinism, container policy |
| Version lock | Ready | Gateway/schema/Kroki/Mermaid lock và release manifest |
| Release artifacts | Ready locally | VSIX, Action bundle, Compose, config, SBOM, checksum, release notes |
| Fork image publication | Ready in workflow | Tagged workflow publish Gateway/Kroki/Mermaid cùng product tag/digest |
| Known limitations | Ready | Release notes và E2E guide |
| Ba full Product CI xanh liên tiếp | Pending external evidence | Gắn ba run URL liên tiếp |
| Pilot repository PR | Partial external evidence | [Repository pilot](https://github.com/hnamkk/mykroki-action-pilot), [PR stale #1](https://github.com/hnamkk/mykroki-action-pilot/pull/1), [PR syntax #2](https://github.com/hnamkk/mykroki-action-pilot/pull/2); còn ghi nhận visual review/final baseline vào biên bản |
| Upgrade/rollback rehearsal bằng hai version thật | Pending external evidence | Gắn biên bản, người thực hiện và thời gian |
| Mentor acceptance session | Pending external evidence | Gắn issue/biên bản và quyết định scope |

## Chủ sở hữu trước release

| Khu vực | Owner cần chỉ định |
|---|---|
| Gateway/Compose/TLS/rollback | Platform owner |
| Kroki fork và renderer images | Renderer owner |
| VSIX/Action/config/pilot | Toolchain owner |
| Security/NFR/go-no-go | QA lead hoặc mentor |

## No-Go conditions

- Bất kỳ P0/P1 blocker mở nào liên quan credential, private source, data integrity hoặc renderer isolation.
- Một trong ba image release không cùng product tag/digest trong manifest.
- Check mode ghi workspace hoặc fork PR nhận write credential.
- Checksum/SBOM/manifest không khớp.
- Recovery cần thao tác ngoài restart policy đã ghi.
- Chưa có ba lần Product CI xanh liên tiếp.
- Chưa diễn tập rollback hoặc chưa có owner rollback.

## Biên bản acceptance

Điền sau buổi pilot:

| Trường | Giá trị |
|---|---|
| Ngày/giờ | |
| Commit/tag ứng viên | |
| Pilot repository/PR | [hnamkk/mykroki-action-pilot](https://github.com/hnamkk/mykroki-action-pilot), [PR #1](https://github.com/hnamkk/mykroki-action-pilot/pull/1), [PR #2](https://github.com/hnamkk/mykroki-action-pilot/pull/2) |
| Product CI run 1 | |
| Product CI run 2 | |
| Product CI run 3 | |
| Upgrade version | |
| Rollback version | |
| P0/P1 issue còn mở | |
| Known limitation được chấp nhận | |
| Quyết định | Go / Conditional Go / No-Go |
| Mentor/QA sign-off | |
