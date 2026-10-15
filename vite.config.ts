import { defineConfig } from 'vite'

// Pages project sites live below the repository name; local development uses /.
const repository = process.env.GITHUB_REPOSITORY?.split('/').pop() || 'run-car'
export default defineConfig({ base: process.env.GITHUB_ACTIONS ? '/' + repository + '/' : '/' })
