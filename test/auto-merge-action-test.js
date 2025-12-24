const tap = require('tap')

const { mockCore } = require('gh-action-components')
const { TestAutoMerger, serverUrl, runId } = require('./test-helpers')

process.env.GITHUB_REPOSITORY = 'spiderstrategies/unittest'

tap.test(`generateMergeWarning`, async t => {
	const coreMock = mockCore({})
	const action = new TestAutoMerger({
		prNumber: 123,
		core: coreMock
	})
	action.generateMergeConflictWarning()

	const expectedStatus = '<https://github.com/sample/repo/issues/123|PR #123> ' +
		'<https://github.com/sample/repo/1#issuecomment-123xyz|Issue> ' +
		'<https://github.com/sample/repo/actions/runs/1935306317|Action Run>'

	t.equal(action.statusMessage, expectedStatus)
	t.equal(coreMock.warningMsgs.length, 1, 'should have warning')
	t.equal(coreMock.warningMsgs[0], expectedStatus, 'warning should match status message')
})

tap.test(`initialize state`, async t => {
	const coreMock = mockCore({})
	const action = new TestAutoMerger({
		prNumber: 123,
		pullRequest: { merge_commit_sha: 'abc123' },
		config: { mergeTargets: ['main'] },
		core: coreMock
	})

	await action.initializeState()

	t.equal(action.terminalBranch, 'main')
	t.ok(coreMock.infoMsgs.some(msg => msg.includes('mergeTargets')))
	t.ok(coreMock.infoMsgs.some(msg => msg.includes('terminal branch')))
})

/**
 *
 */
tap.test(`error status`, async t => {
	const coreMock = mockCore({})
	const action = new TestAutoMerger({
		core: coreMock
	})

	action.core.setFailed('Test error')
	t.equal(coreMock.failedArg, 'Test error')
})

// Asserts fix for scenario like this
// https://github.com/SpiderStrategies/Scoreboard/runs/6423638921?check_suite_focus=true
tap.test(`pr number`, async t => {

	let action = new TestAutoMerger({})
	action.setOriginalPrNumber('issue-undefined-pr-47384-conflicts-2022', '47387')
	t.equal('47384', action.originalPrNumber, 'must accept undefined as an issue number')

	action.setOriginalPrNumber('issue-12345-pr-47384-conflicts-2022', '47387')
	t.equal('47384', action.originalPrNumber, 'must accept any numeric issue number')

	action.setOriginalPrNumber('issue-unexpected123-pr-47384-conflicts-2022', '47387')
	t.equal('47384', action.originalPrNumber, `don't really care what is in issue place, we're just looking for the pr number`)
})

tap.test(`getOriginBranchForConflict`, async t => {
	let action = new TestAutoMerger({})
	action.config = {
		mergeTargets: [ 'a', 'b', 'c' ]
	}
	await action.initializeState()
	t.test(`omits branch-here for terminal branch`, async t => {
		const actual = action.getOriginBranchForConflict('c')
		t.equal('origin/c', actual)
	})
	t.test(`includes branch-here for non terminal branches`, async t => {
		t.equal('origin/branch-here-a', action.getOriginBranchForConflict('a'))
		t.equal('origin/branch-here-b', action.getOriginBranchForConflict('b'))
	})
})

tap.test('conflictsBranchName handles spaces in alias', async t => {
	let action = new TestAutoMerger({})
	const actual = action.conflictsBranchName('1', 'Branch 1.5 emergency', '2')
	t.equal('issue-1-pr-2-conflicts-Branch-1.5-emergency', actual)
})

tap.test('createMergeConflictsBranchName encodes source and target branches', async t => {
	let action = new TestAutoMerger({})

	t.test('handles standard branch names', async t => {
		const actual = action.createMergeConflictsBranchName('68586', 'release-5.8.0', 'main')
		t.equal('merge-conflicts-68586-release-5-8-0-to-main', actual)
	})

	t.test('handles branch names without dots', async t => {
		const actual = action.createMergeConflictsBranchName('12345', 'develop', 'main')
		t.equal('merge-conflicts-12345-develop-to-main', actual)
	})

	t.test('handles multiple dots in version numbers', async t => {
		const actual = action.createMergeConflictsBranchName('68590', 'release-5.7.2', 'release-5.8.0')
		t.equal('merge-conflicts-68590-release-5-7-2-to-release-5-8-0', actual)
	})
})

tap.test('executeMerges', async t => {
	t.test('successful merge to all targets', async t => {
		const execCalls = []
		const gitCalls = []
		const startGroups = []
		const endGroupCount = []
		const core = mockCore({})
		core.startGroup = (msg) => startGroups.push(msg)
		core.endGroup = () => endGroupCount.push(1)

		const mockGit = {
			async checkout(branch) {
				execCalls.push(`git checkout ${branch}`)
			},
			async deleteBranch(branch) {
				gitCalls.push(`deleteBranch:${branch}`)
			}
		}

		class TestAction extends TestAutoMerger {
			async merge({branch}) {
				return true  // Success
			}
		}

		const action = new TestAction({
			prBranch: 'issue-123-my-fix',
			core,
			git: mockGit
		})

		const result = await action.executeMerges(['release-5.7', 'release-5.8', 'main'])

		t.equal(result, true, 'should return true when all merges succeed')
		t.equal(execCalls.filter(c => c.startsWith('git checkout')).length, 3, 'should checkout all branches')
		t.equal(gitCalls.find(c => c.includes('deleteBranch:issue-123-my-fix')), 'deleteBranch:issue-123-my-fix', 'should delete PR branch on success')
		t.equal(startGroups.length, 3, 'should start group for each merge')
		t.equal(endGroupCount.length, 3, 'should end group for each merge')
	})

	t.test('stops merging on first conflict', async t => {
		const execCalls = []
		const core = mockCore({})

		const mockGit = {
			async checkout(branch) {
				execCalls.push(`git checkout ${branch}`)
			}
		}

		class TestAction extends TestAutoMerger {
			async merge({branch}) {
				// Fail on second branch
				return branch !== 'release-5.8'
			}

			generateMergeConflictWarning() {
				this.warningGenerated = true
			}
		}

		const action = new TestAction({
			prBranch: 'issue-123-my-fix',
			core,
			git: mockGit
		})
		action.conflictBranch = 'release-5.8'

		const result = await action.executeMerges(['release-5.7', 'release-5.8', 'main'])

		t.equal(result, false, 'should return false when merge fails')
		t.equal(execCalls.filter(c => c.startsWith('git checkout')).length, 2, 'should stop after failed merge')
		t.equal(action.warningGenerated, true, 'should generate conflict warning')
	})

	t.test('handles merge exception', async t => {
		const execCalls = []
		const core = mockCore({})

		const mockGit = {
			async checkout(branch) {
				execCalls.push(`git checkout ${branch}`)
			}
		}

		class TestAction extends TestAutoMerger {
			async merge({branch}) {
				if (branch === 'release-5.8') {
					throw new Error('Git merge failed')
				}
				return true
			}
		}

		const action = new TestAction({
			prBranch: 'issue-123-my-fix',
			core,
			git: mockGit
		})

		const result = await action.executeMerges(['release-5.7', 'release-5.8', 'main'])

		t.equal(result, false, 'should return false when exception occurs')
		t.ok(core.failedArg, 'should call setFailed when exception occurs')
		t.equal(execCalls.filter(c => c.startsWith('git checkout')).length, 2, 'should stop after exception')
	})
})

tap.test('run', async t => {
	t.test('skips when PR not merged', async t => {
		let infoCalled = false
		const core = mockCore({})
		core.info = () => { infoCalled = true }

		const action = new TestAutoMerger({
			pullRequest: {
				merged: false
			},
			core
		})

		await action.run()

		t.ok(infoCalled, 'should log info about skipping')
	})

	t.test('skips when PR against terminal branch', async t => {
		const core = mockCore({})
		const action = new TestAutoMerger({
			pullRequest: {
				merged: true,
				merge_commit_sha: 'abc123'
			},
			config: {
				mergeTargets: ['main']
			},
			core
		})
		action.terminalBranch = null

		await action.initializeState()

		t.equal(action.terminalBranch, 'main')
	})
})

tap.test('merge', async t => {
	t.test('handles already merged case', async t => {
		const execCalls = []
		const core = mockCore({})

		const mockGit = {
			async pull() {
				execCalls.push('git pull')
			},
			async merge(sha, options) {
				execCalls.push(`git merge ${sha}`)
				return 'Already up to date.'
			},
			async commit(message, author) {
				execCalls.push('git commit')
			}
		}

		const action = new TestAutoMerger({
			pullRequest: {
				head: { sha: 'abc123' }
			},
			baseBranch: 'release-5.7',
			prNumber: 456,
			prBranch: 'my-feature',
			core,
			git: mockGit
		})

		const result = await action.merge({branch: 'release-5.8'})

		t.equal(result, true, 'should return true even when already merged')
		t.ok(execCalls.find(c => c.includes('git pull')), 'should pull before merging')
		t.ok(execCalls.find(c => c.includes('git merge abc123')), 'should attempt merge')
		t.notOk(execCalls.find(c => c.includes('git commit')), 'should not commit when already merged')
	})

	t.test('successful merge creates commit', async t => {
		let commitCalled = false
		const core = mockCore({})

		const mockGit = {
			async pull() {},
			async merge(sha, options) {
				return 'Merge made by strategy'
			},
			async commit(message, author) {
				commitCalled = true
				t.ok(author, 'should pass author to commit')
				t.equal(author.name, 'Test', 'should use correct author name')
			}
		}

		const mockGh = {
			github: {
				context: {
					serverUrl,
					runId,
					repo: { owner: 'sample', repo: 'repo' }
				}
			},
			async fetchCommits(prNum) {
				return {
					data: [{
						commit: {
							author: { name: 'Test', email: 'test@example.com' }
						}
					}]
				}
			}
		}

		const action = new TestAutoMerger({
			pullRequest: {
				head: { sha: 'def456' }
			},
			baseBranch: 'release-5.7',
			prNumber: 789,
			prBranch: 'my-feature',
			core,
			git: mockGit,
			gh: mockGh
		})

		const result = await action.merge({branch: 'release-5.8'})

		t.equal(result, true, 'should return true on success')
		t.ok(commitCalled, 'should create commit when merge successful')
	})

	t.test('handles conflicts', async t => {
		let conflictsHandled = false
		const core = mockCore({})

		const mockGit = {
			async pull() {},
			async merge(sha, options) {
				throw new Error('Merge conflict')
			}
		}

		class TestAction extends TestAutoMerger {
			async handleConflicts(branch) {
				conflictsHandled = true
			}
		}

		const action = new TestAction({
			pullRequest: {
				head: { sha: 'ghi789' }
			},
			baseBranch: 'release-5.7',
			prNumber: 999,
			prBranch: 'my-feature',
			core,
			git: mockGit
		})

		const result = await action.merge({branch: 'release-5.8'})

		t.equal(result, false, 'should return false when conflicts occur')
		t.ok(conflictsHandled, 'should call handleConflicts')
	})
})
