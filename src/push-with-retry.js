/**
 * How many times to build and push a shared branch before giving up. Three is
 * ample for the roughly one-second window between a fetch and a push; a burst
 * of merges long enough to exhaust it is a genuine failure worth surfacing.
 */
const PUSH_ATTEMPTS = 3

/**
 * Applies [merge] to the current tip of [branch] and pushes the result,
 * retrying when a concurrent merge-bot run advances [branch] between our fetch
 * and our push (#74377).
 *
 * Every attempt re-fetches and hard-resets to the remote tip, so a rejected
 * push never leaves a half-applied merge behind. Resetting is safe at every
 * call site because whatever is being merged lives on the remote - a
 * merge-forward branch or the PR's head commit - so there is no local work to
 * lose.
 *
 * @param {Object} options
 * @param {Object} options.shell - Shell instance for executing commands
 * @param {Object} options.core - The @actions/core module for logging
 * @param {string} options.branch - The branch to advance and push
 * @param {Function} options.merge - Performs the merge. Called once per
 *   attempt, always with [branch] checked out at the remote tip.
 * @param {number} [options.attempts=PUSH_ATTEMPTS] - How many times to try
 * @returns {Promise<string>} Output of the push that succeeded
 * @throws The final push rejection when every attempt is rejected
 */
async function pushWithRetry({ shell, core, branch, merge, attempts = PUSH_ATTEMPTS }) {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		await shell.exec(`git checkout ${branch}`)
		await shell.exec(`git fetch origin ${branch}`)
		await shell.exec(`git reset --hard origin/${branch}`)

		await merge()

		try {
			return await shell.exec(`git push origin ${branch}`)
		} catch (e) {
			if (attempt === attempts) {
				throw e
			}
			core.info(`Push of ${branch} was rejected` +
				` (attempt ${attempt} of ${attempts});` +
				` retrying against its new tip`)
		}
	}
}

module.exports = pushWithRetry
module.exports.PUSH_ATTEMPTS = PUSH_ATTEMPTS
