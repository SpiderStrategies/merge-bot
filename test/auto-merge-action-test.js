const tap = require('tap')

const { mockCore } = require('gh-action-components')

const AutoMergeAction = require('../src/automerge')

const serverUrl = 'https://github.com'
const runId = 1935306317

process.env.GITHUB_REPOSITORY = 'spiderstrategies/unittest'

class ActionStub extends AutoMergeAction {

	constructor(options = {}) {
		super(options)
		this.repoUrl = `https://github.com/sample/repo`
		this.conflictBranch = 'conflict-branch'
		this.issueUrl = 'https://github.com/sample/repo/1#issuecomment-123xyz'
		this.actionUrl = `${serverUrl}/sample/repo/actions/runs/${runId}`
	}

	async exec(cmd) {
		if (cmd.startsWith('git log')) {
			return this.logOutput
		}
	}
}

tap.test(`generateMergeWarning`, async t => {
	const action = new ActionStub({
		prNumber: 123
	})
	const coreMock = mockCore({})
	action.core = coreMock
	action.generateMergeConflictWarning(['master'])

	const expectedStatus = '<https://github.com/sample/repo/issues/123|PR #123> ' +
		'<https://github.com/sample/repo/1#issuecomment-123xyz|Issue> ' +
		'<https://github.com/sample/repo/actions/runs/1935306317|Action Run>'

	t.equal(action.statusMessage, expectedStatus)
	t.equal(coreMock.outputs['status-message'], expectedStatus)
	t.equal(coreMock.outputs['status'], 'warning')
})

tap.test(`initialize state`, async t => {
	const action = new ActionStub({
		prNumber: 123,
		pullRequest: {}
	})
	action.github = {
		context: {
			serverUrl:
			runId,
			repo: {
				owner: 'sample',
				repo: 'repo'
			}
		}
	}
	const coreMock = mockCore({})
	action.core = coreMock

	await action.postConstruct()
	await action.initializeState()

	t.equal(coreMock.outputs['status'], 'success')
	t.equal(coreMock.outputs['status-message'], `<${action.actionUrl}|Action Run>`)

})

/**
 *
 */
tap.test(`error status`, async t => {
	const action = new ActionStub({})
	const coreMock = mockCore({})
	action.core = coreMock
	await action.onError()
	t.equal(coreMock.outputs['status'], 'failure')
})

// Asserts fix for scenario like this
// https://github.com/SpiderStrategies/Scoreboard/runs/6423638921?check_suite_focus=true
tap.test(`pr number`, async t => {

	let action = new ActionStub({})
	action.setOriginalPrNumber('issue-undefined-pr-47384-conflicts-2022', '47387')
	t.equal('47384', action.originalPrNumber, 'must accept undefined as an issue number')

	action.setOriginalPrNumber('issue-12345-pr-47384-conflicts-2022', '47387')
	t.equal('47384', action.originalPrNumber, 'must accept any numeric issue number')

	action.setOriginalPrNumber('issue-unexpected123-pr-47384-conflicts-2022', '47387')
	t.equal('47384', action.originalPrNumber, `don't really care what is in issue place, we're just looking for the pr number`)
})

tap.test(`getOriginBranchForConflict`, async t => {
	let action = new ActionStub({})
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
	let action = new ActionStub({})
	const actual = action.conflictsBranchName('1', 'Branch 1.5 emergency', '2')
	t.equal('issue-1-pr-2-conflicts-Branch-1.5-emergency', actual)
})

tap.test('createMergeConflictsBranchName encodes source and target branches', async t => {
	let action = new ActionStub({})

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
		const startGroups = []
		const endGroupCount = []

		class TestAction extends ActionStub {
			async exec(cmd) {
				execCalls.push(cmd)
				return ''
			}

			async merge({branch}) {
				return true  // Success
			}

			startGroup(msg) {
				startGroups.push(msg)
			}

			endGroup() {
				endGroupCount.push(1)
			}

			async deleteBranch(branch) {
				execCalls.push(`deleteBranch:${branch}`)
			}
		}

		const action = new TestAction({
			prBranch: 'issue-123-my-fix'
		})
		action.core = mockCore({})

		const result = await action.executeMerges(['release-5.7', 'release-5.8', 'main'])

		t.equal(result, true, 'should return true when all merges succeed')
		t.equal(execCalls.filter(c => c.startsWith('git checkout')).length, 3, 'should checkout all branches')
		t.equal(execCalls.find(c => c.includes('deleteBranch:issue-123-my-fix')), 'deleteBranch:issue-123-my-fix', 'should delete PR branch on success')
		t.equal(startGroups.length, 3, 'should start group for each merge')
		t.equal(endGroupCount.length, 3, 'should end group for each merge')
	})

	t.test('stops merging on first conflict', async t => {
		const execCalls = []

		class TestAction extends ActionStub {
			async exec(cmd) {
				execCalls.push(cmd)
				return ''
			}

			async merge({branch}) {
				// Fail on second branch
				return branch !== 'release-5.8'
			}

			startGroup() {}
			endGroup() {}

			generateMergeConflictWarning() {
				this.warningGenerated = true
			}
		}

		const action = new TestAction({
			prBranch: 'issue-123-my-fix'
		})
		action.core = mockCore({})
		action.conflictBranch = 'release-5.8'

		const result = await action.executeMerges(['release-5.7', 'release-5.8', 'main'])

		t.equal(result, false, 'should return false when merge fails')
		t.equal(execCalls.filter(c => c.startsWith('git checkout')).length, 2, 'should stop after failed merge')
		t.equal(action.warningGenerated, true, 'should generate conflict warning')
	})

	t.test('handles merge exception', async t => {
		const execCalls = []
		let errorHandled = false

		class TestAction extends ActionStub {
			async exec(cmd) {
				execCalls.push(cmd)
				return ''
			}

			async merge({branch}) {
				if (branch === 'release-5.8') {
					throw new Error('Git merge failed')
				}
				return true
			}

			async onError(err) {
				errorHandled = true
				this.core.setOutput('status', 'failure')
			}

			startGroup() {}
			endGroup() {}
		}

		const action = new TestAction({
			prBranch: 'issue-123-my-fix'
		})
		action.core = mockCore({})

		const result = await action.executeMerges(['release-5.7', 'release-5.8', 'main'])

		t.equal(result, false, 'should return false when exception occurs')
		t.equal(errorHandled, true, 'should call onError when exception occurs')
		t.equal(execCalls.filter(c => c.startsWith('git checkout')).length, 2, 'should stop after exception')
	})
})

tap.test('runAction', async t => {
	t.test('skips when PR not merged', async t => {
		let infoCalled = false
		const action = new ActionStub({
			pullRequest: {
				merged: false
			}
		})
		const core = mockCore({})
		core.info = () => { infoCalled = true }
		action.core = core
		action.github = {
			context: {
				serverUrl: 'https://github.com',
				runId: 123,
				repo: { owner: 'test', repo: 'test' }
			}
		}

		await action.runAction()

		t.ok(infoCalled, 'should log info about skipping')
	})

	t.test('skips when PR against terminal branch', async t => {
		const action = new ActionStub({
			pullRequest: {
				merged: true,
				merge_commit_sha: 'abc123'
			}
		})
		action.core = mockCore({})
		action.github = {
			context: {
				serverUrl: 'https://github.com',
				runId: 123,
				repo: { owner: 'test', repo: 'test' }
			}
		}
		action.config = {
			mergeTargets: ['main']
		}
		action.terminalBranch = null

		await action.postConstruct()
		await action.initializeState()

		t.equal(action.terminalBranch, 'main')
	})
})

tap.test('merge', async t => {
	t.test('handles already merged case', async t => {
		const execCalls = []

		class TestAction extends ActionStub {
			async exec(cmd) {
				execCalls.push(cmd)
				if (cmd.startsWith('git merge')) {
					return 'Already up to date.'
				}
				return ''
			}
		}

		const action = new TestAction({
			pullRequest: {
				head: { sha: 'abc123' }
			},
			baseBranch: 'release-5.7',
			prNumber: 456,
			prBranch: 'my-feature'
		})
		action.core = mockCore({})

		const result = await action.merge({branch: 'release-5.8'})

		t.equal(result, true, 'should return true even when already merged')
		t.ok(execCalls.find(c => c.includes('git pull')), 'should pull before merging')
		t.ok(execCalls.find(c => c.includes('git merge abc123')), 'should attempt merge')
		t.notOk(execCalls.find(c => c.includes('git commit')), 'should not commit when already merged')
	})

	t.test('successful merge creates commit', async t => {
		const execCalls = []
		let commitCalled = false

		class TestAction extends ActionStub {
			async exec(cmd) {
				execCalls.push(cmd)
				if (cmd.startsWith('git merge')) {
					return 'Merge made by strategy'
				}
				return ''
			}

			async fetchCommits(prNum) {
				return {
					data: [{
						commit: {
							author: { name: 'Test', email: 'test@example.com' }
						}
					}]
				}
			}

			async commit(message, author) {
				commitCalled = true
			}
		}

		const action = new TestAction({
			pullRequest: {
				head: { sha: 'def456' }
			},
			baseBranch: 'release-5.7',
			prNumber: 789,
			prBranch: 'my-feature'
		})
		action.core = mockCore({})

		const result = await action.merge({branch: 'release-5.8'})

		t.equal(result, true, 'should return true on success')
		t.ok(commitCalled, 'should create commit when merge successful')
	})

	t.test('handles conflicts', async t => {
		let conflictsHandled = false

		class TestAction extends ActionStub {
			async exec(cmd) {
				if (cmd.startsWith('git merge')) {
					throw new Error('Merge conflict')
				}
				return ''
			}

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
			prBranch: 'my-feature'
		})
		action.core = mockCore({})

		const result = await action.merge({branch: 'release-5.8'})

		t.equal(result, false, 'should return false when conflicts occur')
		t.ok(conflictsHandled, 'should call handleConflicts')
	})
})
