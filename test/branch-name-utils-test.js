const tap = require('tap')
const { 
	extractPRFromMergeForward,
	extractPRFromMergeConflicts,
	extractTargetFromMergeForward,
	extractOriginalPRNumber
} = require('../src/branch-name-utils')

tap.test('extractPRFromMergeForward', async t => {
	t.test('extracts PR number from merge-forward branch', async t => {
		const result = extractPRFromMergeForward('merge-forward-pr-12345-release-5.8.0')
		t.equal(result, '12345')
	})

	t.test('extracts PR number when target is main', async t => {
		const result = extractPRFromMergeForward('merge-forward-pr-999-main')
		t.equal(result, '999')
	})

	t.test('returns null for non-merge-forward branch', async t => {
		const result = extractPRFromMergeForward('feature-branch')
		t.equal(result, null)
	})

	t.test('returns null for merge-conflicts branch', async t => {
		const result = extractPRFromMergeForward('merge-conflicts-123-pr-456-release-5.8.0-to-main')
		t.equal(result, null)
	})
})

tap.test('extractPRFromMergeConflicts', async t => {
	t.test('extracts PR number from merge-conflicts branch', async t => {
		const result = extractPRFromMergeConflicts('merge-conflicts-68586-pr-12345-release-5.8.0-to-main')
		t.equal(result, '12345')
	})

	t.test('extracts PR from branch with multiple release versions', async t => {
		const result = extractPRFromMergeConflicts('merge-conflicts-999-pr-456-release-5.7.2-to-release-5.8.0')
		t.equal(result, '456')
	})

	t.test('returns null for non-merge-conflicts branch', async t => {
		const result = extractPRFromMergeConflicts('feature-branch')
		t.equal(result, null)
	})

	t.test('returns null for merge-forward branch', async t => {
		const result = extractPRFromMergeConflicts('merge-forward-pr-123-main')
		t.equal(result, null)
	})
})

tap.test('extractTargetFromMergeForward', async t => {
	t.test('extracts target branch from merge-forward', async t => {
		const result = extractTargetFromMergeForward('merge-forward-pr-123-release-5.8.0')
		t.equal(result, 'release-5.8.0')
	})

	t.test('extracts main as target', async t => {
		const result = extractTargetFromMergeForward('merge-forward-pr-456-main')
		t.equal(result, 'main')
	})

	t.test('handles branch names with multiple dots', async t => {
		const result = extractTargetFromMergeForward('merge-forward-pr-789-release-5.7.2')
		t.equal(result, 'release-5.7.2')
	})

	t.test('returns branch without prefix for malformed branch', async t => {
		const result = extractTargetFromMergeForward('merge-forward-pr-123')
		t.equal(result, 'merge-forward-pr-123')
	})
})

tap.test('extractOriginalPRNumber', async t => {
	t.test('extracts from merge-forward base ref', async t => {
		t.equal(extractOriginalPRNumber({
			baseRef: 'merge-forward-pr-70452-release-5.8.0',
			headRef: 'some-feature-branch',
			prNumber: 70465
		}), '70452')
	})

	t.test('extracts from merge-conflicts head ref', async t => {
		t.equal(extractOriginalPRNumber({
			baseRef: 'main',
			headRef: 'merge-conflicts-70468-pr-70452' +
				'-release-5.8.0-to-main',
			prNumber: 70469
		}), '70452')
	})

	t.test('prefers base over head when both present',
			async t => {
		t.equal(extractOriginalPRNumber({
			baseRef: 'merge-forward-pr-100-main',
			headRef: 'merge-conflicts-200-pr-999' +
				'-release-5.8.0-to-main',
			prNumber: 999
		}), '100')
	})

	t.test('falls back to prNumber for normal PRs',
			async t => {
		t.equal(extractOriginalPRNumber({
			baseRef: 'release-5.7.2',
			headRef: 'feature-branch',
			prNumber: 70452
		}), 70452)
	})
})
