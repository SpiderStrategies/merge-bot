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
