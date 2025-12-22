const tap = require('tap')

const { mockCore } = require('gh-action-components')

const BranchMaintainerAction = require('../src/maintain-branches')

const serverUrl = 'https://github.com'
const runId = 1935306317

process.env.GITHUB_REPOSITORY = 'spiderstrategies/unittest'

class ActionStub extends BranchMaintainerAction {

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

tap.test(`maintainBranches`, async t => {
	let action = new ActionStub({})
	action.config = {
		branches: ['t']
	}
	action.terminalBranch = 't'
	await action.maintainBranches()
	// no blowup is the assertion, we expect an immediate break
})

tap.test(`maintainBranches errors`, async t => {
	let action = new ActionStub({})
	  , coreMock = mockCore({})

	action.config = {
		branches: ['abc123', 'efg456']
	}
	action.core = coreMock
	action.terminalBranch = 't'
	await action.maintainBranches()
	t.equal(coreMock.outputs['status'], 'failure')
})

tap.test('deleteBranch detects simple merge-conflicts branches', async t => {
	const deletedBranches = []

	class TestAction extends BranchMaintainerAction {
		constructor(options) {
			super(options)
		}

		async fetchCommits() {
			return { data: [] }
		}

		async execQuietly(cmd) {
			if (cmd.startsWith('git push origin --delete ')) {
				const branchName = cmd.replace('git push origin --delete ', '')
				deletedBranches.push(branchName)
			}
		}
	}

	const action = new TestAction({
		pullRequest: {
			number: 1,
			title: 'Merge conflicts #68875',
			head: {
				ref: 'merge-conflicts-68875'
			},
			body: 'Fixes #68875'
		}
	})

	await action.deleteBranch()

	t.equal(deletedBranches.length, 1, 'should delete the merge-conflicts branch')
	t.equal(deletedBranches[0], 'merge-conflicts-68875', 'should delete the correct branch')
})

tap.test('deleteBranch detects encoded merge-conflicts branches', async t => {
	const deletedBranches = []

	class TestAction extends BranchMaintainerAction {
		constructor(options) {
			super(options)
		}

		async fetchCommits() {
			return { data: [] }
		}

		async execQuietly(cmd) {
			if (cmd.startsWith('git push origin --delete ')) {
				const branchName = cmd.replace('git push origin --delete ', '')
				deletedBranches.push(branchName)
			}
		}
	}

	const action = new TestAction({
		pullRequest: {
			number: 2,
			title: 'Merge conflicts #68895',
			head: {
				ref: 'merge-conflicts-68895-release-5-7-2-to-release-5-8-0'
			},
			body: 'Fixes #68895'
		}
	})

	await action.deleteBranch()

	t.equal(deletedBranches.length, 1, 'should delete the merge-conflicts branch')
	t.equal(deletedBranches[0], 'merge-conflicts-68895', 'should delete the correct branch')
})

tap.test('deleteBranch ignores non-merge-conflict branches', async t => {
	const deletedBranches = []

	class TestAction extends BranchMaintainerAction {
		constructor(options) {
			super(options)
		}

		async fetchCommits() {
			return { data: [] }
		}

		async execQuietly(cmd) {
			if (cmd.startsWith('git push origin --delete ')) {
				const branchName = cmd.replace('git push origin --delete ', '')
				deletedBranches.push(branchName)
			}
		}
	}

	const action = new TestAction({
		pullRequest: {
			number: 3,
			head: {
				ref: 'feature-my-awesome-feature'
			},
			body: 'Fixes #12345'
		}
	})

	await action.deleteBranch()

	t.equal(deletedBranches.length, 0, 'should not delete non-merge-conflicts branches')
})
