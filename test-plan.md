# Spider Merge Bot - Integration Testing

## Automated Tests

Core merge scenarios are tested automatically in `test/real-git-test.js`:
- **Phase 1**: Basic merge-forward (no conflicts)
- **Phase 1a**: Successful chain with branch cleanup
- **Phase 1b**: Multi-step chain (conflicts at main)
- **Phase 2**: Conflict detection
- **Phase 3**: Conflict isolation (Scenario Beta)
- **Resume chain**: Multi-invocation continuation

Run with: `npm test`

## Manual Integration Testing (in Spider Impact)

After deploying changes, verify end-to-end in the real environment:

### Quick Smoke Test

1. Create a simple PR to an early release branch (e.g., `release-5.7.2`)
2. Merge it and watch the action: `gh run watch`
3. Verify: File appears in all downstream branches, no errors

### Conflict Resolution Test

1. Create a PR that will conflict at main
2. Merge it, verify conflict issue is created
3. Follow the issue instructions to resolve
4. Verify: Chain completes, cleanup happens

### Isolation Test (if Scenario Beta changes were made)

1. Create two PRs from the same `branch-here` point
2. Merge both quickly
3. Verify: Each user's conflict issue only shows their own changes

## Monitoring

```bash
gh run list              # List recent action runs
gh run watch             # Watch current run
gh issue list --label "merge conflict"  # View conflict issues
git branch -r | grep merge-forward      # Check merge-forward branches
```

## Notes

- The `merge-bot-test.txt` file in Impact is used for controlled testing
- Always branch from `branch-here-*` branches, never from `release-*` directly
