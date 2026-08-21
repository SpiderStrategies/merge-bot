const tap = require('tap')
const { 
	extractPRFromMergeForward,
	extractPRFromMergeConflicts,
	extractTargetFromMergeForward,
	extractSourceFromMergeConflicts,
	extractOriginalPRNumber,
	extractMergedPRNumber
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

tap.test('extractSourceFromMergeConflicts', async t => {
	t.test('extracts source branch targeting main', async t => {
		t.equal(extractSourceFromMergeConflicts(
			'merge-conflicts-71392-pr-71347-release-5.8.0-to-main'),
		'release-5.8.0')
	})

	t.test('extracts source branch targeting another release', async t => {
		t.equal(extractSourceFromMergeConflicts(
			'merge-conflicts-999-pr-456-release-5.7.2-to-release-5.8.0'),
		'release-5.7.2')
	})

	t.test('returns null for non-merge-conflicts branch', async t => {
		t.equal(extractSourceFromMergeConflicts('feature-branch'), null)
	})

	t.test('returns null for merge-forward branch', async t => {
		t.equal(extractSourceFromMergeConflicts(
			'merge-forward-pr-123-main'), null)
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

tap.test('extractMergedPRNumber', async t => {
	t.test('extracts PR from a GitHub merge commit', async t => {
		t.equal(extractMergedPRNumber(
			'Merge pull request #74485 from SpiderStrategies/' +
			'73891-consolidated-stack'),
		'74485')
	})

	t.test('extracts PR from a merge-bot forward merge', async t => {
		t.equal(extractMergedPRNumber(
			'auto-merge of 22ab4bd97 into `main` from ' +
			'`feature-branch` triggered by (#73972) on ' +
			'`release-5.8.1`'),
		'73972')
	})

	t.test('extracts PR from a branch-here sync', async t => {
		t.equal(extractMergedPRNumber(
			'Merge #70168 into branch-here-release-5.8.0'),
		'70168')
	})

	t.test('returns null for a hand-rolled branch merge', async t => {
		// manual-merge.sh names no PR, so callers fail open
		t.equal(extractMergedPRNumber(
			'Merge release-5.8.1 into main'), null)
	})

	t.test('returns null for a merge-bot issue title', async t => {
		// #74510 - the bot's conflict issue title names an
		// ISSUE, not a PR, so it must not be read as ownership
		t.equal(extractMergedPRNumber(
			'Merge #73891 (22ab4bd97) into main'), null)
	})

	t.test('returns null for an empty or missing subject', async t => {
		t.equal(extractMergedPRNumber(''), null)
		t.equal(extractMergedPRNumber(undefined), null)
	})
})
