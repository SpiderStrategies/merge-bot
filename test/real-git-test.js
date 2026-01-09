/**
 * Real Git Integration Tests
 *
 * These tests use actual git operations (not mocks) to verify the merge-bot
 * behavior matches the scenarios described in test-plan.md.
 *
 * The tests create temporary git repositories with conflicting branches
 * to verify that:
 * - Phase 1: Basic merge-forward works
 * - Phase 2: Conflict detection and resolution works
 * - Phase 3: Conflict isolation works (Scenario Beta)
 */

const tap = require('tap')
const { mkdtemp, rm, writeFile } = require('fs/promises')
const { tmpdir } = require('os')
const { join } = require('path')
const { execSync } = require('child_process')

const { mockCore } = require('gh-action-components')

/**
 * Helper to run git commands in a test repo
 */
function createGitHelper(repoDir) {
	return (cmd) => {
		return execSync(`git ${cmd}`, {
			cwd: repoDir,
			encoding: 'utf-8',
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'Test',
				GIT_AUTHOR_EMAIL: 'test@test.com',
				GIT_COMMITTER_NAME: 'Test',
				GIT_COMMITTER_EMAIL: 'test@test.com'
			}
		}).trim()
	}
}

/**
 * Creates a test repo with origin, simulating the Spider Impact setup:
 * - main branch with one version of a file
 * - release branch with a different version
 * - branch-here-* branches pointing to the right places
 */
async function createTestRepo() {
	const repoDir = await mkdtemp(join(tmpdir(), 'merge-bot-repo-'))
	const originDir = await mkdtemp(join(tmpdir(), 'merge-bot-origin-'))

	const git = createGitHelper(repoDir)

	// Create bare origin
	execSync('git init --bare', { cwd: originDir })

	// Initialize repo
	git('init')
	git('config user.email "test@test.com"')
	git('config user.name "Test"')
	git(`remote add origin ${originDir}`)

	return { repoDir, originDir, git }
}

async function cleanupTestRepo(repoDir, originDir) {
	await rm(repoDir, { recursive: true, force: true })
	await rm(originDir, { recursive: true, force: true })
}

tap.test('Phase 1: Basic merge-forward (no conflicts)', async t => {
	// This test verifies that non-conflicting changes merge cleanly
	// using the correct merge direction (target branch base, PR merged into it)
	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create initial commit
	await writeFile(join(repoDir, 'test.txt'), 'Initial content\n')
	git('add test.txt')
	git('commit -m "Initial commit"')

	// Create release-5.7.2 branch
	git('checkout -b release-5.7.2')
	git('push origin release-5.7.2')

	// Create release-5.8.0 from release-5.7.2 (identical initially)
	git('checkout -b release-5.8.0')
	git('push origin release-5.8.0')

	// Create branch-here pointers
	git('branch branch-here-release-5.8.0 release-5.8.0')
	git('push origin branch-here-release-5.8.0')

	// Simulate a PR: add a NEW file (doesn't conflict with anything)
	git('checkout release-5.7.2')
	await writeFile(join(repoDir, 'new-feature.txt'), 'New feature\n')
	git('add new-feature.txt')
	git('commit -m "Add new feature"')
	const prCommit = git('rev-parse HEAD')
	git('push origin release-5.7.2')

	// Test the correct merge direction (what the fixed merge() does):
	// 1. Create merge-forward from target's branch-here
	// 2. Merge PR commit INTO it
	git('checkout -b merge-forward-test branch-here-release-5.8.0')

	let mergeSucceeded = true
	try {
		git(`merge ${prCommit} --no-ff -m "Merge PR"`)
	} catch (e) {
		mergeSucceeded = false
	}

	t.ok(mergeSucceeded, 'non-conflicting changes should merge cleanly')

	// Verify the file was merged
	const files = git('ls-files')
	t.ok(files.includes('new-feature.txt'), 'new file should be in merged branch')
})

tap.test('Phase 1b: Multi-step chain (merges through release, then conflicts at main)', async t => {
	// This test verifies a PR that merges cleanly through intermediate release
	// branches but then conflicts when reaching main
	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create initial commit
	await writeFile(join(repoDir, 'test.txt'), 'Original\n')
	git('add test.txt')
	git('commit -m "Initial"')

	// Create release-5.7.2 (PR base)
	git('checkout -b release-5.7.2')
	git('push origin release-5.7.2')
	git('branch branch-here-release-5.7.2')
	git('push origin branch-here-release-5.7.2')

	// Create release-5.8.0 (same content as 5.7.2 - no conflict here)
	git('checkout -b release-5.8.0')
	git('push origin release-5.8.0')
	git('branch branch-here-release-5.8.0')
	git('push origin branch-here-release-5.8.0')

	// Create main with DIFFERENT content (will conflict)
	git('checkout -b main')
	await writeFile(join(repoDir, 'test.txt'), 'MAIN VERSION\n')
	git('add test.txt')
	git('commit -m "Main version"')
	git('push origin main')
	git('branch branch-here-main')
	git('push origin branch-here-main')

	// Simulate PR: modify test.txt in release-5.7.2
	git('checkout release-5.7.2')
	await writeFile(join(repoDir, 'test.txt'), 'PR CHANGE\n')
	git('add test.txt')
	git('commit -m "PR change"')
	const prCommit = git('rev-parse HEAD')
	git('push origin release-5.7.2')

	// Use real Shell and Git
	const { Shell, Git } = require('gh-action-components')
	const core = mockCore({})
	const shell = new Shell(core)
	shell.exec = async (cmd) => {
		if (cmd.startsWith('gh ')) return ''
		return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
	}
	const gitHelper = new Git(shell)

	// Track what happens
	let conflictsDetected = false
	let conflictBranch = null
	const createdBranches = []

	const AutoMerger = require('../src/automerger')
	class TestAutoMerger extends AutoMerger {
		async handleConflicts(branch) {
			conflictsDetected = true
			conflictBranch = branch
			this.conflictBranch = branch
			await this.git.reset(branch, '--hard')
		}
	}

	// Override createBranch to track branch creation
	const originalCreateBranch = gitHelper.createBranch.bind(gitHelper)
	gitHelper.createBranch = async (name, ref) => {
		createdBranches.push(name)
		return originalCreateBranch(name, ref)
	}

	// Override commit to use simple git commit (avoids .commitmsg file issues)
	gitHelper.commit = async (message, author) => {
		const authorStr = `${author.name} <${author.email}>`
		// Escape backticks and quotes in message to avoid shell interpretation
		const escapedMsg = message.replace(/`/g, "'").replace(/"/g, '\\"')
		return shell.exec(`git commit -m "${escapedMsg}" --author="${authorStr}"`)
	}

	const action = new TestAutoMerger({
		pullRequest: { merged: true, head: { sha: prCommit } },
		repository: { owner: 'test', name: 'repo' },
		config: {
			branches: {},
			mergeTargets: ['release-5.8.0', 'main'],
			getBranchAlias: (branch) => branch.replace(/\./g, '-')
		},
		prNumber: 999,
		prAuthor: 'testuser',
		prTitle: 'Test multi-step',
		prBranch: 'feature',
		baseBranch: 'release-5.7.2',
		prCommitSha: prCommit,
		core,
		shell,
		gh: {
			github: { context: { serverUrl: 'https://github.com', runId: 1, repo: { owner: 'test', repo: 'repo' } } },
			async createIssue() { return { data: { number: 69517, html_url: 'http://example.com' } } },
			async fetchCommits() { return { data: [{ commit: { author: { name: 'Test', email: 'test@test.com' } } }] } }
		},
		git: gitHelper
	})

	action.terminalBranch = 'main'
	action.lastSuccessfulBranch = 'release-5.7.2'
	action.lastSuccessfulMergeRef = prCommit

	// Execute the full merge chain
	const result = await action.executeMerges(['release-5.8.0', 'main'])

	// Verify chain stopped at main (conflict)
	t.equal(result, false, 'executeMerges should return false when conflict at main')
	t.ok(conflictsDetected, 'conflict should be detected at main')
	t.equal(conflictBranch, 'main', 'conflict should be at main, not release-5.8.0')

	// Verify merge-forward branch was created for successful step
	t.ok(createdBranches.includes('merge-forward-pr-999-release-5-8-0'),
		'should create merge-forward branch for successful release-5.8.0 merge')

	// Verify merge-forward branch was created for conflict step
	t.ok(createdBranches.includes('merge-forward-pr-999-main'),
		'should create merge-forward branch for main (before conflict detected)')
})

tap.test('Phase 2: Conflict detection at main', async t => {
	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create initial commit with test file
	await writeFile(join(repoDir, 'test.txt'), 'Original content\nLine 2\n')
	git('add test.txt')
	git('commit -m "Initial commit"')

	// Create main with a DIFFERENT version
	git('checkout -b main')
	await writeFile(join(repoDir, 'test.txt'), 'MAIN VERSION\nLine 2\n')
	git('add test.txt')
	git('commit -m "Main version"')
	git('push origin main')

	// Create branch-here-main
	git('branch branch-here-main')
	git('push origin branch-here-main')

	// Go back and create release branch with yet another version
	git('checkout HEAD~1')
	git('checkout -b release-5.8.0')
	await writeFile(join(repoDir, 'test.txt'), 'RELEASE VERSION\nLine 2\n')
	git('add test.txt')
	git('commit -m "Release version"')
	const prCommit = git('rev-parse HEAD')
	git('push origin release-5.8.0')

	// Use real Shell and Git
	const { Shell, Git } = require('gh-action-components')
	const core = mockCore({})
	const shell = new Shell(core)
	shell.exec = async (cmd) => {
		if (cmd.startsWith('gh ')) return ''
		return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
	}
	const gitHelper = new Git(shell)

	// Track conflicts
	let conflictsDetected = false
	let conflictFiles = null

	const AutoMerger = require('../src/automerger')
	class TestAutoMerger extends AutoMerger {
		async handleConflicts(branch) {
			conflictsDetected = true
			conflictFiles = await this.shell.exec('git diff --name-only --diff-filter=U')
			this.conflictBranch = branch
			await this.git.reset(branch, '--hard')
		}
	}

	const action = new TestAutoMerger({
		pullRequest: { merged: true, head: { sha: prCommit } },
		repository: { owner: 'test', name: 'repo' },
		config: { branches: {}, mergeTargets: ['main'], getBranchAlias: () => 'main' },
		prNumber: 200,
		prAuthor: 'testuser',
		prTitle: 'Test conflict',
		prBranch: 'release-5.8.0',
		baseBranch: 'release-5.8.0',
		prCommitSha: prCommit,
		core,
		shell,
		gh: {
			github: { context: { serverUrl: 'https://github.com', runId: 1, repo: { owner: 'test', repo: 'repo' } } },
			async createIssue() { return { data: { number: 999, html_url: 'http://example.com' } } },
			async fetchCommits() { return { data: [{ commit: { author: { name: 'Test', email: 'test@test.com' } } }] } }
		},
		git: gitHelper
	})

	action.terminalBranch = 'main'
	action.lastSuccessfulBranch = 'release-5.8.0'
	action.lastSuccessfulMergeRef = prCommit

	await gitHelper.checkout('main')
	const result = await action.merge({ branch: 'main' })

	t.equal(result, false, 'merge should return false when conflict detected')
	t.ok(conflictsDetected, 'handleConflicts should be called')
	t.ok(conflictFiles.includes('test.txt'), 'should detect conflict in test.txt')
	t.equal(action.conflictBranch, 'main', 'conflictBranch should be set to main')
})

tap.test('Phase 3: Conflict isolation (Scenario Beta)', async t => {
	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create initial commit
	await writeFile(join(repoDir, 'test.txt'), 'Original\n')
	git('add test.txt')
	git('commit -m "Initial"')

	// Main has one version
	git('checkout -b main')
	await writeFile(join(repoDir, 'test.txt'), 'MAIN VERSION\n')
	git('add test.txt')
	git('commit -m "Main version"')
	git('push origin main')
	git('branch branch-here-main')
	git('push origin branch-here-main')

	// Create release branch (base for User A and User B PRs)
	git('checkout HEAD~1')
	git('checkout -b release-5.7.2')
	await writeFile(join(repoDir, 'test.txt'), 'RELEASE BASE\n')
	git('add test.txt')
	git('commit -m "Release base"')
	git('push origin release-5.7.2')
	git('branch branch-here-release-5.7.2')
	git('push origin branch-here-release-5.7.2')

	// User A's change
	git('checkout release-5.7.2')
	await writeFile(join(repoDir, 'test.txt'), 'USER A VERSION\n')
	git('add test.txt')
	git('commit -m "User A change"')
	const userACommit = git('rev-parse HEAD')

	// User B's change (from the SAME base as User A - simulating both branching before either merges)
	git('checkout branch-here-release-5.7.2')
	git('checkout -b user-b-branch')
	await writeFile(join(repoDir, 'test.txt'), 'USER B VERSION\n')
	git('add test.txt')
	git('commit -m "User B change"')
	const userBCommit = git('rev-parse HEAD')

	// Use real Shell and Git
	const { Shell, Git } = require('gh-action-components')
	const core = mockCore({})

	// Test User A's merge - should detect conflict with main
	t.test('User A detects conflict with main', async t => {
		const shell = new Shell(core)
		shell.exec = async (cmd) => {
			if (cmd.startsWith('gh ')) return ''
			return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
		}
		const gitHelper = new Git(shell)

		let conflictsDetected = false
		const AutoMerger = require('../src/automerger')
		class TestAutoMerger extends AutoMerger {
			async handleConflicts(branch) {
				conflictsDetected = true
				this.conflictBranch = branch
				await this.git.reset(branch, '--hard')
			}
		}

		const action = new TestAutoMerger({
			pullRequest: { merged: true, head: { sha: userACommit } },
			repository: { owner: 'test', name: 'repo' },
			config: { branches: {}, mergeTargets: ['main'], getBranchAlias: () => 'main' },
			prNumber: 301,
			prAuthor: 'userA',
			prTitle: 'User A PR',
			prBranch: 'user-a-branch',
			baseBranch: 'release-5.7.2',
			prCommitSha: userACommit,
			core,
			shell,
			gh: {
				github: { context: { serverUrl: 'https://github.com', runId: 1, repo: { owner: 'test', repo: 'repo' } } },
				async createIssue() { return { data: { number: 999, html_url: 'http://example.com' } } },
				async fetchCommits() { return { data: [{ commit: { author: { name: 'Test', email: 'test@test.com' } } }] } }
			},
			git: gitHelper
		})

		action.terminalBranch = 'main'
		action.lastSuccessfulBranch = 'release-5.7.2'
		action.lastSuccessfulMergeRef = userACommit

		await gitHelper.checkout('main')
		const result = await action.merge({ branch: 'main' })

		t.equal(result, false, 'User A should detect conflict with main')
		t.ok(conflictsDetected, 'handleConflicts should be called for User A')
	})

	// Test User B's merge - should ALSO detect conflict with main
	// Crucially, User B should NOT see User A's changes in their conflict
	t.test('User B detects conflict with main (isolated from User A)', async t => {
		const shell = new Shell(core)
		shell.exec = async (cmd) => {
			if (cmd.startsWith('gh ')) return ''
			return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
		}
		const gitHelper = new Git(shell)

		let conflictsDetected = false
		let conflictContent = null

		const AutoMerger = require('../src/automerger')
		class TestAutoMerger extends AutoMerger {
			async handleConflicts(branch) {
				conflictsDetected = true
				// Capture the conflict content to verify isolation
				try {
					conflictContent = execSync('cat test.txt', { cwd: repoDir, encoding: 'utf-8' })
				} catch (e) {
					conflictContent = 'error reading file'
				}
				this.conflictBranch = branch
				await this.git.reset(branch, '--hard')
			}
		}

		const action = new TestAutoMerger({
			pullRequest: { merged: true, head: { sha: userBCommit } },
			repository: { owner: 'test', name: 'repo' },
			config: { branches: {}, mergeTargets: ['main'], getBranchAlias: () => 'main' },
			prNumber: 302,
			prAuthor: 'userB',
			prTitle: 'User B PR',
			prBranch: 'user-b-branch',
			baseBranch: 'release-5.7.2',
			prCommitSha: userBCommit,
			core,
			shell,
			gh: {
				github: { context: { serverUrl: 'https://github.com', runId: 1, repo: { owner: 'test', repo: 'repo' } } },
				async createIssue() { return { data: { number: 999, html_url: 'http://example.com' } } },
				async fetchCommits() { return { data: [{ commit: { author: { name: 'Test', email: 'test@test.com' } } }] } }
			},
			git: gitHelper
		})

		action.terminalBranch = 'main'
		action.lastSuccessfulBranch = 'release-5.7.2'
		action.lastSuccessfulMergeRef = userBCommit

		await gitHelper.checkout('main')
		const result = await action.merge({ branch: 'main' })

		t.equal(result, false, 'User B should detect conflict with main')
		t.ok(conflictsDetected, 'handleConflicts should be called for User B')

		// Verify isolation: User B's conflict should be between USER B VERSION and MAIN VERSION
		// It should NOT include USER A VERSION
		t.ok(conflictContent, 'should have conflict content')
		t.ok(conflictContent.includes('USER B VERSION') || conflictContent.includes('MAIN VERSION'),
			'conflict should involve User B and main')
		t.notOk(conflictContent.includes('USER A VERSION'),
			'User B conflict should NOT include User A changes (isolation)')
	})
})

tap.test('Merge direction: demonstrates bug vs fix', async t => {
	// This test explicitly shows why the merge direction matters
	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup conflicting branches
	await writeFile(join(repoDir, 'test.txt'), 'Original\n')
	git('add test.txt')
	git('commit -m "Initial"')

	git('checkout -b main')
	await writeFile(join(repoDir, 'test.txt'), 'MAIN\n')
	git('add test.txt')
	git('commit -m "Main"')
	git('branch branch-here-main')
	git('push origin main branch-here-main')

	git('checkout HEAD~1')
	git('checkout -b release')
	await writeFile(join(repoDir, 'test.txt'), 'RELEASE\n')
	git('add test.txt')
	git('commit -m "Release"')
	const releaseCommit = git('rev-parse HEAD')

	t.test('BUGGY: creating branch from PR then merging same PR = "Already up to date"', async t => {
		// This is what the old code did
		git('checkout -b merge-forward-buggy ' + releaseCommit)
		let result
		try {
			result = git(`merge ${releaseCommit} --no-commit --no-ff`)
		} catch (e) {
			result = 'conflict'
		}

		t.ok(result.includes('Already up to date') || result === '',
			'buggy approach returns "Already up to date" - no conflict detected!')
		git('checkout main')
		git('branch -D merge-forward-buggy')
	})

	t.test('CORRECT: creating branch from target then merging PR = detects conflict', async t => {
		// This is what the fixed code does
		git('checkout -b merge-forward-correct branch-here-main')
		let conflictDetected = false
		try {
			git(`merge ${releaseCommit} --no-commit --no-ff`)
		} catch (e) {
			conflictDetected = true
		}

		t.ok(conflictDetected, 'correct approach detects the conflict')
		git('merge --abort || true')
		git('checkout main')
		git('branch -D merge-forward-correct')
	})
})
