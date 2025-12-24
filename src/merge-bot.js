const core = require('@actions/core')
const github = require('@actions/github')

const AutoMerger = require('./automerger')
const BranchMaintainer = require('./branch-maintainer')
const { configReader, Shell, GitHubClient, Git } = require('gh-action-components')

const { pull_request, repository } = github.context.payload
const configFile = core.getInput('config-file', { required: true })

const { number: prNumber, title, base, head, user } = pull_request

async function run() {
	// Read config once for both phases
	const config = configReader(configFile, { baseBranch: base.ref })

	// Create infrastructure components (shared across phases)
	const shell = new Shell(core)
	const gh = new GitHubClient({ core, github })
	const git = new Git(shell)

	// Phase 1: Merge forward
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

	// Phase 2: Maintain branch-here pointers
	const maintainer = new BranchMaintainer({
		pullRequest: pull_request,
		config,
		core,
		shell
	})
	await maintainer.run({ automergeConflictBranch: automerger.conflictBranch })

	// Set final status based on automerge phase (orchestrator owns outputs)
	setFinalStatus(automerger)
}

/**
 * Sets the final status outputs based on the automerge phase.
 * The orchestrator owns these outputs to prevent phases from clobbering each other.
 *
 * @param {AutoMerger} automerger The automerger instance
 */
function setFinalStatus(automerger) {
	if (automerger.conflictBranch) {
		// Automerge had conflicts - set warning status
		core.setOutput('status', 'warning')
		core.setOutput('status-message', automerger.statusMessage)
	} else {
		core.setOutput('status', 'success')
		core.setOutput('status-message', `<${automerger.actionUrl}|Action Run>`)
	}
}

run()
