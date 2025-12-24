/**
 * Closes issues that are referenced with GitHub keywords in commit messages.
 */
class IssueResolver {

	/**
	 * @param {Object} options
	 * @param {number} options.prNumber - The pull request number
	 * @param {Object} options.core - The @actions/core module for logging
	 * @param {Object} options.shell - Shell instance for executing commands
	 * @param {Object} options.gh - GitHubClient instance for GitHub API
	 */
	constructor({ prNumber, core, shell, gh }) {
		this.prNumber = prNumber
		this.core = core
		this.shell = shell
		this.gh = gh
	}

	/**
	 * Closes all issues referenced with GitHub keywords in the commit messages
	 * for the active PR.
	 */
	async resolveIssues() {
		await this._loadCommitMessages()
		for (let issueNumber of this.getFixedIssues()) {
			// https://github.com/SpiderStrategies/Scoreboard/issues/48570
			this.core.info(`Closing issue referenced in commits: ${issueNumber}`)
			// GH API works great here (couldn't get ocktokit to work)
			await this.shell.exec(`gh issue close ${issueNumber}`)
		}
	}

	/**
	 * @returns {String[]} issue numbers that were resolved in the PR
	 */
	getFixedIssues() {
		let issueNumbers = []
		// https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue#linking-a-pull-request-to-an-issue-using-a-keyword
		const rex = /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)(?:[\s\w\/-]+#(\d+))/gi
		this.commitMessages.forEach(m => {
			this.core.debug(`Extracting issue numbers from commit message: ${m}`)
			const matches = m.matchAll(rex)
			if (matches) {
				for (const match of matches) {
					// The capture; just the issue number
					issueNumbers.push(match[1])
				}
			}

		})
		return issueNumbers
	}

	async _loadCommitMessages() {
		const commits = await this.gh.fetchCommits(this.prNumber)
		this.commitMessages = commits.data.map(c => c.commit.message)
		this.core.info(`Commit messages are: ${this.commitMessages}`)
	}
}

module.exports = IssueResolver
