const tap = require('tap')

// Setup mocks before requiring any modules
const github = require('@actions/github')
const core = require('@actions/core')
const AutoMergeAction = require('../src/automerge')
const BranchMaintainerAction = require('../src/maintain-branches')

let coreInfoMessages = []

/**
 * Sets up the test environment with mock github context and core
 */
function setupTestEnvironment(baseBranch = 'main') {
	coreInfoMessages = []

	github.context = {
		payload: {
			pull_request: {
				merged: true,
				number: 123,
				title: 'Test PR',
				base: { ref: baseBranch },
				head: { ref: 'feature-branch', sha: 'abc123' },
				user: { login: 'testuser' }
			},
			repository: { owner: 'test', name: 'repo' }
		},
		serverUrl: 'https://github.com',
		runId: 123,
		repo: { owner: 'test', repo: 'repo' }
	}

	core.info = (msg) => coreInfoMessages.push(msg)
	core.setOutput = () => {}
	core.getInput = () => '.github/workflows/config.yml'
}

/**
 * Mocks the AutoMergeAction and BranchMaintainerAction to track execution
 */
function mockActions({ automergeState }) {
	const state = {
		automergeRan: false,
		maintainerRan: false,
		originalAutoMergeRun: AutoMergeAction.prototype.run,
		originalMaintainerRun: BranchMaintainerAction.prototype.run
	}

	AutoMergeAction.prototype.run = async function() {
		state.automergeRan = true
		this.terminalBranch = automergeState.terminalBranch
		this.conflictBranch = automergeState.conflictBranch
	}

	BranchMaintainerAction.prototype.run = async function() {
		state.maintainerRan = true
	}

	return state
}

/**
 * Mocks the config reader to return test config
 */
function mockConfigReader(config) {
	const ghActionComponents = require('gh-action-components')
	const originalConfigReader = ghActionComponents.configReader

	ghActionComponents.configReader = () => config

	return () => {
		ghActionComponents.configReader = originalConfigReader
	}
}

/**
 * Runs the merge-bot module and waits for execution
 */
async function runMergeBot() {
	delete require.cache[require.resolve('../src/merge-bot')]
	require('../src/merge-bot')
	await new Promise(resolve => setTimeout(resolve, 100))
}

/**
 * Restores all mocked actions
 */
function restoreActions(state) {
	AutoMergeAction.prototype.run = state.originalAutoMergeRun
	BranchMaintainerAction.prototype.run = state.originalMaintainerRun
}

tap.test('maintainBranchHerePointers', async t => {
	const testConfig = {
		branches: {
			'release-5.6.0': {},
			'release-5.7.0': {},
			'main': {}
		}
	}

	t.test('skips branch maintenance when PR merged directly to terminal branch', async t => {
		setupTestEnvironment('main')

		const mockState = mockActions({
			automergeState: {
				terminalBranch: undefined,  // PR to terminal branch
				conflictBranch: undefined
			}
		})

		const restoreConfig = mockConfigReader(testConfig)

		try {
			await runMergeBot()

			t.ok(mockState.automergeRan, 'automerge should have run')
			t.notOk(mockState.maintainerRan, 'branch maintainer should NOT run for PR to terminal branch')

			const skipMessage = coreInfoMessages.find(msg =>
				msg.includes('Skipping branch maintenance') && msg.includes('terminal branch'))
			t.ok(skipMessage, 'should log skip message for terminal branch')
		} finally {
			restoreActions(mockState)
			restoreConfig()
		}
	})

	t.test('runs branch maintenance when PR merged to non-terminal branch and automerge succeeds', async t => {
		setupTestEnvironment('release-5.7.0')

		const mockState = mockActions({
			automergeState: {
				terminalBranch: 'main',      // Successful automerge
				conflictBranch: undefined    // No conflicts
			}
		})

		const restoreConfig = mockConfigReader({
			...testConfig,
			mergeTargets: ['main']
		})

		try {
			await runMergeBot()

			t.ok(mockState.automergeRan, 'automerge should have run')
			t.ok(mockState.maintainerRan, 'branch maintainer SHOULD run when commits reached main')

			const maintenanceMessage = coreInfoMessages.find(msg =>
				msg.includes('Running branch maintenance'))
			t.ok(maintenanceMessage, 'should log that branch maintenance is running')
		} finally {
			restoreActions(mockState)
			restoreConfig()
		}
	})
})

