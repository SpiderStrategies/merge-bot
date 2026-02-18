const tap = require('tap')
const github = require('@actions/github')
const { createTestEnvironment, useTestActions } = require('./test-helpers')

/**
 * Runs merge-bot and waits for completion
 */
async function runMergeBot() {
	require('../src/merge-bot')
	await new Promise(resolve => setTimeout(resolve, 100))
}

tap.test('maintainBranchHerePointers', async t => {
	const baseConfig = {
		branches: {
			'release-5.6.0': {},
			'release-5.7.0': {},
			'main': {}
		},
		mergeOperations: {
			'release-5.6.0': 'release-5.7.0',
			'release-5.7.0': 'main'
		}
	}

	t.test('skips branch maintenance when PR merged directly to terminal branch', async t => {
		const testState = createTestEnvironment({
			baseBranch: 'main',
			config: baseConfig
		})

		const restore = useTestActions(testState)

		try {
			await runMergeBot()

			t.ok(testState.automergeRan, 'automerge should have run')
			t.notOk(testState.maintainerRan, 'branch maintainer should NOT run for PR to terminal branch')

			const skipMessage = testState.coreInfoMessages.find(msg =>
				msg.includes('Skipping branch maintenance') && msg.includes('terminal branch'))
			t.ok(skipMessage, 'should log skip message for terminal branch')
		} finally {
			restore()
		}
	})

	t.test('runs branch maintenance when PR merged to non-terminal branch and automerge succeeds', async t => {
		const testState = createTestEnvironment({
			baseBranch: 'release-5.7.0',
			config: { ...baseConfig, mergeTargets: ['main'] }
		})
		testState.terminalBranch = 'main'  // Successful automerge

		const restore = useTestActions(testState)

		try {
			await runMergeBot()

			t.ok(testState.automergeRan, 'automerge should have run')

			const maintenanceMessage = testState.coreInfoMessages.find(msg =>
				msg.includes('Running branch maintenance'))
			t.ok(maintenanceMessage, 'should log that branch maintenance is running')
		} finally {
			restore()
		}
	})

	t.test('cleans up merge-conflicts branch when conflicts PR merged to terminal branch', async t => {
		const testState = createTestEnvironment({
			baseBranch: 'main',
			prHeadRef: 'merge-conflicts-68875-release-5-7-0-to-main',
			config: baseConfig
		})

		// Set body to include "Fixes" statement
		github.context.payload.pull_request.body = 'Fixes #68875'

		const restore = useTestActions(testState)

		try {
			await runMergeBot()

			t.ok(testState.cleanupMergeConflictsBranchCalled, 'cleanupMergeConflictsBranch should be called for merge-conflicts PR to terminal branch')
		} finally {
			restore()
		}
	})
})

