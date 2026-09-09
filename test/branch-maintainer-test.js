const tap = require('tap')

const { mockCore } = require('gh-action-components')
const { TestBranchMaintainer, createMockShell, createGitShellBehavior } = require('./test-helpers')
const BranchMaintainer = require('../src/branch-maintainer')

process.env.GITHUB_REPOSITORY = 'spiderstrategies/unittest'

function createDeleteBranchMocks() {
	const deletedBranches = []
	const core = mockCore({})
	const mockShell = {
		core,
		async execQuietly(cmd) {
			if (cmd.startsWith('git push origin --delete ')) {
				const branchName = cmd.replace('git push origin --delete ', '')
				deletedBranches.push(branchName)
			}
		}
	}
	return { deletedBranches, core, mockShell }
}

tap.test('cleanupMergeConflictsBranch detects simple merge-conflicts branches', async t => {
	const { deletedBranches, core, mockShell } = createDeleteBranchMocks()

	const maintainer = new BranchMaintainer({
		pullRequest: {
			number: 1,
			title: 'Merge conflicts #68875',
			head: {
				ref: 'merge-conflicts-68875'
			},
			base: {
				ref: 'merge-forward-pr-123-main' // Not terminal branch
			},
			body: 'Fixes #68875'
		},
		config: { branches: { main: {} }, mergeOperations: {} },
		core,
		shell: mockShell
	})

	await maintainer.cleanupMergeConflictsBranch()

	t.equal(deletedBranches.length, 1, 'should delete the merge-conflicts branch')
	t.equal(deletedBranches[0], 'merge-conflicts-68875', 'should delete the full branch name')
})

tap.test('cleanupMergeConflictsBranch detects encoded merge-conflicts branches', async t => {
	const { deletedBranches, core, mockShell } = createDeleteBranchMocks()

	const maintainer = new BranchMaintainer({
		pullRequest: {
			number: 2,
			title: 'Merge conflicts #68895',
			head: {
				ref: 'merge-conflicts-68895-release-5.7.2-to-release-5.8.0'
			},
			base: {
				ref: 'merge-forward-pr-456-release-5.8.0' // Not terminal branch
			},
			body: 'Fixes #68895'
		},
		config: { branches: { main: {} }, mergeOperations: {} },
		core,
		shell: mockShell
	})

	await maintainer.cleanupMergeConflictsBranch()

	t.equal(deletedBranches.length, 1, 'should delete the merge-conflicts branch')
	// Now deletes full branch name, not just prefix+issue
	t.equal(deletedBranches[0], 'merge-conflicts-68895-release-5.7.2-to-release-5.8.0',
		'should delete the full branch name')
})

tap.test('cleanupMergeConflictsBranch ignores non-merge-conflict branches', async t => {
	const { deletedBranches, core, mockShell } = createDeleteBranchMocks()

	const maintainer = new BranchMaintainer({
		pullRequest: {
			number: 3,
			head: {
				ref: 'feature-my-awesome-feature'
			},
			base: {
				ref: 'main'
			},
			body: 'Fixes #12345'
		},
		config: { branches: { main: {} }, mergeOperations: {} },
		core,
		shell: mockShell
	})

	await maintainer.cleanupMergeConflictsBranch()

	t.equal(deletedBranches.length, 0, 'should not delete non-merge-conflicts branches')
})

tap.test('cleanupMergeForwardBranches', async t => {
	t.test('deletes all merge-forward branches for a PR', async t => {
		const deletedBranches = []
		const core = mockCore({})

		const execBehavior = createGitShellBehavior({
			mergeForwardBranches: {
				'12345': [
					{ branch: 'release-5.7', sha: 'sha1' },
					{ branch: 'release-5.8', sha: 'sha2' },
					{ branch: 'main', sha: 'sha3' }
				]
			}
		})

		const mockShell = createMockShell(core, (cmd) => {
			if (cmd.startsWith('git push origin --delete ')) {
				const branchName = cmd.replace('git push origin --delete ', '')
				deletedBranches.push(branchName)
				return
			}
			return execBehavior(cmd)
		})

		const maintainer = new BranchMaintainer({
			pullRequest: {
				number: 12345,
				head: { ref: 'feature-branch' },
				base: { ref: 'release-5.7' },
				merged: true
			},
			config: {
				branches: {
					'release-5.7': {},
					'release-5.8': {},
					'main': {}
				},
				mergeOperations: {}
			},
			core,
			shell: mockShell
		})

		await maintainer.cleanupMergeForwardBranches()

		t.equal(deletedBranches.length, 3, 'should delete all three merge-forward branches')
		t.ok(deletedBranches.includes('merge-forward-pr-12345-release-5.7'), 'should delete release-5.7 branch')
		t.ok(deletedBranches.includes('merge-forward-pr-12345-release-5.8'), 'should delete release-5.8 branch')
		t.ok(deletedBranches.includes('merge-forward-pr-12345-main'), 'should delete main branch')
	})

	t.test('handles case when no merge-forward branches exist', async t => {
		const deletedBranches = []
		const core = mockCore({})

		const execBehavior = createGitShellBehavior({
			mergeForwardBranches: {}  // No branches for any PR
		})

		const mockShell = createMockShell(core, (cmd) => {
			if (cmd.startsWith('git push origin --delete ')) {
				const branchName = cmd.replace('git push origin --delete ', '')
				deletedBranches.push(branchName)
				return
			}
			return execBehavior(cmd)
		})

		const maintainer = new BranchMaintainer({
			pullRequest: {
				number: 99999,
				head: { ref: 'feature-branch' },
				base: { ref: 'main' },
				merged: true
			},
			config: { branches: {}, mergeOperations: {} },
			core,
			shell: mockShell
		})

		await maintainer.cleanupMergeForwardBranches()

		t.equal(deletedBranches.length, 0, 'should not attempt to delete non-existent branches')
	})
})

tap.test('run calls cleanup when commits reach main', async t => {
	const deletedBranches = []
	const core = mockCore({})

	const execBehavior = createGitShellBehavior({
		mergeForwardBranches: {
			'555': [
				{ branch: 'release-5.7', sha: 'sha1' },
				{ branch: 'main', sha: 'sha2' }
			]
		}
	})

	const mockShell = createMockShell(core, (cmd) => {
		if (cmd.startsWith('git push origin --delete ')) {
			const branchName = cmd.replace('git push origin --delete ', '')
			deletedBranches.push(branchName)
			return
		}
		return execBehavior(cmd)
	})

	const maintainer = new TestBranchMaintainer({
		pullRequest: {
			number: 555,
			head: { ref: 'feature-branch', sha: 'abc123' },
			base: { ref: 'release-5.7' },
			merged: true
		},
		config: {
			branches: {
				'release-5.7': {},
				'main': {}
			},
			mergeOperations: {}
		},
		core,
		shell: mockShell
	})

	// Override maintainBranches to avoid complex test setup
	maintainer.maintainBranches = async () => {}

	// Automerger sets conflictBranch to null when there are no conflicts
	await maintainer.run({ automergeConflictBranch: null })

	t.ok(deletedBranches.length > 0, 'should cleanup merge-forward branches when commits reach main')
	t.ok(deletedBranches.includes('merge-forward-pr-555-release-5.7'), 'should delete merge-forward branches')
})

tap.test('run does not cleanup when commits blocked', async t => {
	const deletedBranches = []
	const core = mockCore({})

	const execBehavior = createGitShellBehavior({
		mergeForwardBranches: {
			'666': [
				{ branch: 'release-5.7', sha: 'sha1' }
			]
		}
	})

	const mockShell = createMockShell(core, (cmd) => {
		if (cmd.startsWith('git push origin --delete merge-forward')) {
			const branchName = cmd.replace('git push origin --delete ', '')
			deletedBranches.push(branchName)
			return
		}
		return execBehavior(cmd)
	})

	const maintainer = new TestBranchMaintainer({
		pullRequest: {
			number: 666,
			head: { ref: 'feature-branch' },
			base: { ref: 'release-5.7' },
			merged: true
		},
		config: {
			branches: { 'release-5.8': {}, main: {} },
			mergeOperations: {}
		},
		core,
		shell: mockShell
	})

	// Commits blocked at release-5.8
	await maintainer.run({ automergeConflictBranch: 'release-5.8' })

	t.equal(deletedBranches.length, 0, 'should not cleanup merge-forward branches when commits are blocked')
})

tap.test('advanceBranchHereFromMergeForward', async t => {
	t.test('merges into both branch-here and release branch', async t => {
		const execCalls = []
		const core = mockCore({})

		const mockShell = {
			core,
			async exec(cmd) {
				execCalls.push(cmd)
				return ''
			},
			async execQuietly(cmd) {
				execCalls.push(cmd)
				return ''
			}
		}

		const maintainer = new BranchMaintainer({
			pullRequest: {
				number: 70168,
				head: { ref: 'feature-branch' },
				base: { ref: 'release-5.8.0' },
				merged: true
			},
			config: {
				branches: { 'release-5.8.0': {}, 'main': {} },
				mergeOperations: {}
			},
			core,
			shell: mockShell
		})

		await maintainer.advanceBranchHereFromMergeForward(
			'merge-forward-pr-70168-release-5.8.0')

		// Should merge merge-forward into branch-here
		const branchHereMerge = execCalls.find(c =>
			c.includes('git merge') &&
			c.includes('Merge #70168 into branch-here-release-5.8.0'))
		t.ok(branchHereMerge,
			'should merge into branch-here with PR number in message')

		// Should then merge branch-here into the release branch
		const releaseBranchMerge = execCalls.find(c =>
			c.includes('git merge') &&
			c.includes(
				'Merge #70168 from branch-here-release-5.8.0' +
				' to release-5.8.0'))
		t.ok(releaseBranchMerge,
			'should merge branch-here into release branch ' +
			'with PR number in message')
	})

	t.test('skips branch-here for terminal branch but merges into it', async t => {
		// Issue #43: When BranchMaintainer processes merge-forward-pr-{N}-main,
		// it should skip branch-here advancement (no branch-here-main exists)
		// but still merge the merge-forward content into main.
		// Without this, resolved conflicts at the last hop never reach main.
		const execCalls = []
		const core = mockCore({})

		const mockShell = {
			core,
			async exec(cmd) { execCalls.push(cmd); return '' },
			async execQuietly(cmd) { execCalls.push(cmd); return '' }
		}

		const maintainer = new BranchMaintainer({
			pullRequest: {
				number: 70168,
				head: { ref: 'feature-branch' },
				base: { ref: 'release-5.8.0' },
				merged: true
			},
			config: {
				branches: { 'release-5.8.0': {}, 'main': {} },
				mergeOperations: {}
			},
			core,
			shell: mockShell
		})

		await maintainer.advanceBranchHereFromMergeForward(
			'merge-forward-pr-70168-main')

		// Should NOT touch branch-here-main (doesn't exist)
		const branchHereCmds = execCalls.filter(c =>
			c.includes('branch-here-main'))
		t.equal(branchHereCmds.length, 0,
			'should not touch branch-here for terminal branch')

		// SHOULD merge the merge-forward branch into main
		const checkoutMain = execCalls.find(c =>
			c.includes('git checkout main'))
		t.ok(checkoutMain,
			'should checkout main to merge into it')

		const mergeCmd = execCalls.find(c =>
			c.includes('git merge') &&
			c.includes('merge-forward-pr-70168-main'))
		t.ok(mergeCmd,
			'should merge merge-forward branch into main')

		const pushMain = execCalls.find(c =>
			c.includes('git push') && c.includes('main'))
		t.ok(pushMain,
			'should push updated main')
	})

	t.test('fails when the target is not a configured branch',
		async t => {
			// merge-bot named this branch itself, so an
			// unconfigured target means the config and the
			// live branches disagree. Advancing nothing
			// silently would leave developers unable to
			// branch, so this has to go red.
			const core = mockCore({})
			const mockShell = {
				core,
				async exec() { return '' },
				async execQuietly() { return '' }
			}

			const maintainer = new BranchMaintainer({
				pullRequest: {
					number: 70168,
					head: { ref: 'feature-branch' },
					base: { ref: 'release-5.8.0' },
					merged: true
				},
				config: {
					branches: { 'release-5.8.0': {}, 'main': {} },
					mergeOperations: {}
				},
				core,
				shell: mockShell
			})

			await t.rejects(
				maintainer.advanceBranchHereFromMergeForward(
					'merge-forward-pr-70168-release-9.9.9'),
				/'release-9.9.9' is not a configured branch/,
				'should fail naming the unconfigured target')
		})
})

tap.test('advanceBranchHereAfterConflictResolution', async t => {
	// #74973 - The release branch comes from the original PR,
	// not from the merge-conflicts branch name.
	function createConflictResolutionMocks({ prView } = {}) {
		const execCalls = []
		const core = mockCore({})
		const shell = {
			core,
			async exec(cmd) {
				execCalls.push(cmd)
				if (cmd.startsWith('gh pr view')) {
					return prView()
				}
				return ''
			},
			async execQuietly(cmd) {
				execCalls.push(cmd)
				return ''
			}
		}

		const maintainer = new BranchMaintainer({
			pullRequest: {
				number: 74969,
				head: {
					ref: 'merge-conflicts-74968-pr-74927' +
						'-merge-forward-pr-74927-release-5.9.0' +
						'-to-main',
					sha: 'resolution-sha'
				},
				base: { ref: 'merge-forward-pr-74927-main' },
				merged: true
			},
			config: {
				branches: {
					'release-5.8.0': {},
					'release-5.9.0': {},
					'main': {}
				},
				mergeOperations: {}
			},
			core,
			shell
		})

		return { execCalls, core, maintainer }
	}

	t.test('advances branch-here for the original PR base', async t => {
		const { execCalls, maintainer } = createConflictResolutionMocks({
			prView: () => JSON.stringify({
				baseRefName: 'release-5.8.0',
				headRefOid: 'a6115999e79'
			})
		})

		await maintainer.run({ automergeConflictBranch: null })

		t.ok(execCalls.includes(
			'gh pr view 74927 --json baseRefName,headRefOid'),
		'should read the original PR, not the resolution PR')

		const branchHereMerge = execCalls.find(c =>
			c.startsWith('git merge a6115999e79') &&
			c.includes('Merge #74927 into' +
				' branch-here-release-5.8.0'))
		t.ok(branchHereMerge,
			'should merge the original PR head into' +
			' branch-here for its base branch')

		const strandedTarget = execCalls.find(c =>
			c.includes('branch-here-merge-forward'))
		t.notOk(strandedTarget,
			'should never build a branch-here name from a' +
			' merge-forward branch')
	})

	t.test('warns and skips a base that left the config',
		async t => {
			// Nobody branches from a retired release line, so
			// its pointer staying behind blocks no one
			const { execCalls, core, maintainer } =
				createConflictResolutionMocks({
					prView: () => JSON.stringify({
						baseRefName: 'release-5.6.0',
						headRefOid: 'a6115999e79'
					})
				})

			await maintainer.run({ automergeConflictBranch: null })

			const advanced = execCalls.find(c =>
				c.includes('branch-here-'))
			t.notOk(advanced,
				'should not advance any branch-here')
			t.ok(core.warningMsgs.find(m =>
				m.includes('not a configured branch')),
			'should warn about the unconfigured base')
		})

	t.test('skips when the base branch has no branch-here',
		async t => {
			// A PR based on the terminal branch never merges
			// forward, so there is no pointer to advance
			const { execCalls, core, maintainer } =
				createConflictResolutionMocks({
					prView: () => JSON.stringify({
						baseRefName: 'main',
						headRefOid: 'a6115999e79'
					})
				})

			await maintainer.run({ automergeConflictBranch: null })

			const advanced = execCalls.find(c =>
				c.includes('branch-here-'))
			t.notOk(advanced,
				'should not advance any branch-here')
			t.equal(core.warningMsgs.length, 0,
				'should not warn - there is nothing to advance')
		})

	t.test('fails the run when GitHub reports no base branch',
		async t => {
			const { maintainer } = createConflictResolutionMocks({
				prView: () => JSON.stringify({})
			})

			await t.rejects(
				maintainer.run({ automergeConflictBranch: null }),
				/reported no base branch or head SHA/,
				'should fail on incomplete PR data')
		})

	t.test('fails the run when the original PR cannot be read',
		async t => {
			// A pointer that should advance and doesn't blocks
			// every later PR on that release line, so this has
			// to reach a human rather than pass quietly
			const { maintainer } = createConflictResolutionMocks({
				prView: () => {
					throw new Error('gh: PR not found')
				}
			})

			await t.rejects(
				maintainer.run({ automergeConflictBranch: null }),
				/PR #74927 could not be read/,
				'should fail with the PR it could not read')
		})

	t.test('says how to repair a pointer it could not advance',
		async t => {
			const { maintainer } = createConflictResolutionMocks({
				prView: () => {
					throw new Error('gh: PR not found')
				}
			})

			await t.rejects(
				maintainer.run({ automergeConflictBranch: null }),
				/by hand; until then developers cannot branch/,
				'should name the hand repair the failure needs')
		})
})

tap.test('run skips maintenance when base is not a configured branch', async t => {
	// #72734 - When a PR is merged into a non-configured base
	// (e.g. a feature branch, like PR #72699 was merged into
	// `72162-geographic-...`), BranchMaintainer used to crash
	// trying to advance `branch-here-<feature-branch>`. It
	// should no-op gracefully instead.
	const execCalls = []
	const core = mockCore({})
	const infoMessages = []
	core.info = (msg) => infoMessages.push(msg)

	const mockShell = {
		core,
		async exec(cmd) { execCalls.push(cmd); return '' },
		async execQuietly(cmd) { execCalls.push(cmd); return '' }
	}

	const maintainer = new BranchMaintainer({
		pullRequest: {
			number: 72699,
			head: {
				ref: '72598-missing-variablespunctuation-in' +
					'-error-messages-in-stack-traces-for' +
					'-dataset-field',
				sha: 'abc123'
			},
			base: {
				ref: '72162-geographic-dataset-link-field' +
					'-never-has-data-show-up-in-the-records-tab'
			},
			merged: true
		},
		config: {
			branches: {
				'release-5.8.0': {},
				'main': {}
			},
			mergeOperations: {}
		},
		core,
		shell: mockShell
	})

	await maintainer.run({ automergeConflictBranch: null })

	const advanceCmds = execCalls.filter(c =>
		c.includes('branch-here-') || c.includes('git checkout') ||
		c.includes('git merge') || c.includes('git push origin '))
	t.equal(advanceCmds.length, 0,
		'should not attempt any branch-here advancement ' +
		'or release-branch merges')

	const skipped = infoMessages.find(m =>
		m.includes('not a configured branch'))
	t.ok(skipped,
		'should log a skip message mentioning the ' +
		'non-configured base')
})
