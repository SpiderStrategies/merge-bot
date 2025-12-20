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
