const core = require('@actions/core')
const github = require('@actions/github')

const AutoMerger = require('./automerger')
const BranchMaintainer = require('./branch-maintainer')
const { extractTargetFromMergeForward } = require('./branch-name-utils')
const { MB_BRANCH_FORWARD_PREFIX } = require('./constants')
const { configReader, Shell, GitHubClient, Git } = require('gh-action-components')

const { pull_request, repository } = github.context.payload
const configFile = core.getInput('config-file', { required: true })

const { number: prNumber, title, base, head, user } = pull_request

async function run() {
	const { serverUrl, runId, repo } = github.context
	const actionUrl =
		`${serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${runId}`

	try {
		const config = readConfig()
		const shell = new Shell(core)
		const gh = new GitHubClient({ core, github })
		const git = new Git(shell)

		await git.configureIdentity('Spider Merge Bot',
			'merge-bot@spiderstrategies.com')

		// #72975 - git requires the merge=ours driver in .gitattributes to be
		// registered per clone, or those attributes are a silent no-op.
		// #74377 - Here rather than in the workflow, so release branches whose
		// workflow file predates the rename to merge-bot.yml are covered too.
		await shell.exec('git config merge.ours.driver true')

		const automerger = await automerge({ config, shell, gh, git })
		await maintainBranches({ config, shell, automerger })
		setFinalStatus(automerger)
	} catch (error) {
		// Issue #29 - Ensure Slack gets notified on crashes.
		// Without this, setFinalStatus is never called and
		// the Slack step gets empty outputs.
		let statusMessage =
			`Merge bot error: ${error.message} <${actionUrl}|Action Run>`
		core.setFailed(error.message)
		// #74377 - 'failure', not 'error': the workflow's Slack step filters
		// on notify_when: 'warning,failure'.
		core.setOutput('status', 'failure')
		core.setOutput('status-message', statusMessage)
	}
}

/**
 * Merges the PR forward through the release branch chain.
 * Returns the AutoMerger instance so the caller can check
 * conflictBranch (for branch maintenance) and statusMessage
 * (for Slack notification).
 *
 * @param {Object} deps - Infrastructure dependencies
 * @returns {Promise<AutoMerger>} The automerger after execution
 */
async function automerge({ config, shell, gh, git }) {
	const automerger = new AutoMerger({
		pullRequest: pull_request,
		repository,
		config,
		prNumber,
		prAuthor: user.login,
		prTitle: title,
		prBranch: head.ref,
		baseBranch: base.ref,
		prCommitSha: head.sha,
		core,
		shell,
		gh,
		git
	})
	await automerger.run()
	return automerger
}

/**
 * Updates branch-here pointers and cleans up merge-forward
 * branches after the automerge phase completes.
 *
 * @param {Object} deps - Infrastructure dependencies plus
 *   the automerger result from the previous phase
 */
async function maintainBranches({ config, shell, automerger }) {
	const maintainer = new BranchMaintainer({
		pullRequest: pull_request,
		config,
		core,
		shell
	})
	await maintainer.run({
		automergeConflictBranch:
			automerger.conflictBranch,
		// #74510 - set when the automerge phase deferred to another PR
		chainOwner: automerger.chainOwner
	})
}

/**
 * Reads the merge-bot config, resolving merge-forward branch names
 * to their actual target branches. When a conflict resolution PR
 * merges into a merge-forward branch, base.ref is the merge-forward
 * name (e.g., merge-forward-pr-70412-release-5.8.0) which isn't in
 * the config's mergeOperations. Extracting the real target branch
 * ensures configReader builds correct mergeTargets.
 *
 * @returns {Configuration} The parsed config
 */
function readConfig() {
	const baseBranch = base.ref.startsWith(MB_BRANCH_FORWARD_PREFIX)
		? extractTargetFromMergeForward(base.ref)
		: base.ref
	return configReader(configFile, { baseBranch })
}


/**
 * Sets the final status outputs based on the automerge phase.
 * The orchestrator owns these outputs to prevent phases from clobbering each other.
 *
 * Merge conflicts are expected behavior and count as success - an issue was
 * created for the developer to resolve. Anything else that stopped the chain
 * reports failure, whether it surfaced as an exception or was caught and
 * recorded by executeMerges.
 *
 * @param {AutoMerger} automerger The automerger instance
 */
function setFinalStatus(automerger) {
	// #74377 - executeMerges catches its own exceptions, so run() returns
	// normally and the crash handler never sees a broken chain.
	if (automerger.failureMessage) {
		core.setOutput('status', 'failure')
		core.setOutput('status-message',
			`Merge chain failed: ${automerger.failureMessage}` +
			` <${automerger.actionUrl}|Action Run>`)
		return
	}

	// Both successful merges AND handled conflicts are "success"
	// Conflicts are expected - an issue was created for the developer
	core.setOutput('status', 'success')
	core.setOutput('status-message', automerger.statusMessage ?? `<${automerger.actionUrl}|Action Run>`)
}

run()
