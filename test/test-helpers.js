const github = require('@actions/github')
const core = require('@actions/core')
const { mockCore } = require('gh-action-components')
const AutoMerger = require('../src/automerger')
const BranchMaintainer = require('../src/branch-maintainer')

const serverUrl = 'https://github.com'
const runId = 1935306317

/**
 * Creates a mock Shell for testing
 */
function createMockShell(core, execBehavior = {}) {
	return {
		core,
		async exec(cmd) {
			if (execBehavior[cmd]) {
				return execBehavior[cmd]()
			}
			return ''
		},
		async execQuietly(cmd) {
			try {
				return await this.exec(cmd)
			} catch (e) {
				// Swallow errors
			}
		}
	}
}

/**
 * Creates a mock GitHubClient for testing
 */
function createMockGitHubClient(github) {
	const mockGithub = github ?? {
		context: {
			serverUrl,
			runId,
			repo: { owner: 'sample', repo: 'repo' },
			payload: {
				repository: {
					owner: { login: 'sample' },
					name: 'repo'
				}
			}
		}
	}

	return {
		github: mockGithub,
		octokit: { rest: { pulls: {}, issues: {} } },
		get repo() {
			return { owner: 'sample', repo: 'repo' }
		},
		async fetchCommits() {
			return {
				data: [{
					commit: {
						author: { name: 'Test Author', email: 'test@example.com' },
						message: 'Test commit'
					}
				}]
			}
		},
		async createIssue() {
			return { data: { number: 999, html_url: 'https://github.com/sample/repo/issues/999' } }
		}
	}
}

/**
 * Creates a mock Git for testing
 */
function createMockGit(shell) {
	return {
		shell,
		async commit() {},
		async createBranch() {},
		async deleteBranch() {},
		async checkout() {},
		async pull() {},
		async merge() { return '' },
		async reset() {},
		async configureIdentity() {},
		async push() {}
	}
}

/**
 * Base test stub for AutoMerger that uses mock components
 */
class TestAutoMerger extends AutoMerger {
	constructor(options = {}) {
		const testCore = options.core ?? mockCore({})
		const testGithub = options.github ?? {
			context: {
				serverUrl,
				runId,
				repo: { owner: 'sample', repo: 'repo' }
			}
		}
		const testShell = options.shell ?? createMockShell(testCore)
		const testGh = options.gh ?? createMockGitHubClient(testGithub)
		const testGit = options.git ?? createMockGit(testShell)

		const defaults = {
			pullRequest: { merged: true, head: { sha: 'abc123' } },
			repository: { owner: 'test', name: 'repo' },
			config: { branches: {}, mergeTargets: [], getBranchAlias: () => 'main' },
			prNumber: 123,
			prAuthor: 'testuser',
			prTitle: 'Test PR',
			prBranch: 'feature',
			baseBranch: 'main',
			prCommitSha: 'abc123',
			core: testCore,
			shell: testShell,
			gh: testGh,
			git: testGit,
			...options
		}

		super(defaults)

		// Override URLs for consistent test output
		this.repoUrl = 'https://github.com/sample/repo'
		this.actionUrl = `${serverUrl}/sample/repo/actions/runs/${runId}`
		// Only set conflictBranch if explicitly provided
		if (options.conflictBranch !== undefined) {
			this.conflictBranch = options.conflictBranch
		}
		this.issueUrl = options.issueUrl ?? 'https://github.com/sample/repo/1#issuecomment-123xyz'
	}
}

/**
 * Base test stub for BranchMaintainer that uses mock components
 */
class TestBranchMaintainer extends BranchMaintainer {
	constructor(options = {}) {
		const testCore = options.core ?? mockCore({})
		const testShell = options.shell ?? createMockShell(testCore)

		const defaults = {
			pullRequest: {
				head: { ref: '' },
				base: { ref: 'main' },
				merged: false
			},
			config: { branches: {}, mergeOperations: {} },
			core: testCore,
			shell: testShell,
			...options
		}
		super(defaults)

		// Allow tests to override config after construction
		if (options.config) {
			this.config = options.config
		}
	}
}

/**
 * Creates a test environment for testing merge-bot with necessary context and stubs.
 * Returns a test state object that can be used to track execution and assertions.
 */
function createTestEnvironment({
	baseBranch = 'main',
	prHeadRef = 'feature-branch',
	prNumber = 123,
	merged = true,
	config
}) {
	const coreInfoMessages = []
	const testState = {
		automergeRan: false,
		maintainerRan: false,
		cleanupMergeConflictsBranchCalled: false,
		terminalBranch: undefined,
		conflictBranch: undefined,
		config,
		coreInfoMessages
	}

	// Setup github context
	github.context = {
		payload: {
			pull_request: {
				merged,
				number: prNumber,
				title: 'Test PR',
				base: { ref: baseBranch },
				head: { ref: prHeadRef, sha: 'abc123' },
				user: { login: 'testuser' }
			},
			repository: { owner: 'test', name: 'repo' }
		},
		serverUrl: 'https://github.com',
		runId: 123,
		repo: { owner: 'test', repo: 'repo' }
	}

	// Setup core stubs
	core.info = (msg) => coreInfoMessages.push(msg)
	core.setOutput = () => {}
	core.getInput = () => '.github/workflows/config.yml'

	return testState
}

/**
 * For merge-bot integration tests: creates specialized test action classes
 * that track execution state for assertions
 */
function createMergeBotTestActions(testState) {
	class MergeBotTestAutoMerger extends TestAutoMerger {
		async run() {
			testState.automergeRan = true
			this.terminalBranch = testState.terminalBranch
			this.conflictBranch = testState.conflictBranch
		}
	}

	class MergeBotTestMaintainer extends TestBranchMaintainer {
		constructor(options) {
			super({
				...options,
				config: testState.config
			})
		}

		async cleanupMergeConflictsBranch() {
			testState.cleanupMergeConflictsBranchCalled = true
			await super.cleanupMergeConflictsBranch()
		}

		async maintainBranches() {
			testState.maintainerRan = true
			// Don't actually run maintenance in tests
		}
	}

	return { MergeBotTestAutoMerger, MergeBotTestMaintainer }
}

/**
 * Temporarily replaces action classes with test stubs for integration testing.
 * Returns a restore function to clean up.
 */
function useTestActions(testState) {
	const originalAutoMerger = require.cache[require.resolve('../src/automerger')].exports
	const originalMaintainer = require.cache[require.resolve('../src/branch-maintainer')].exports

	// Clear merge-bot from cache
	delete require.cache[require.resolve('../src/merge-bot')]

	// Create specialized test actions
	const { MergeBotTestAutoMerger, MergeBotTestMaintainer } = createMergeBotTestActions(testState)

	// Inject test classes
	require.cache[require.resolve('../src/automerger')].exports = MergeBotTestAutoMerger
	require.cache[require.resolve('../src/branch-maintainer')].exports = MergeBotTestMaintainer

	// Stub configReader to return test config
	const ghActionComponents = require('gh-action-components')
	const originalConfigReader = ghActionComponents.configReader
	ghActionComponents.configReader = () => testState.config

	return () => {
		// Restore original classes
		require.cache[require.resolve('../src/automerger')].exports = originalAutoMerger
		require.cache[require.resolve('../src/branch-maintainer')].exports = originalMaintainer
		ghActionComponents.configReader = originalConfigReader
		delete require.cache[require.resolve('../src/merge-bot')]
	}
}

module.exports = {
	TestAutoMerger,
	TestBranchMaintainer,
	createTestEnvironment,
	useTestActions,
	createMockShell,
	createMockGitHubClient,
	createMockGit,
	serverUrl,
	runId
}
