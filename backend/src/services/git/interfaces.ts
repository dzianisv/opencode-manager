import type { Database } from 'bun:sqlite'
import type { FileDiffResponse, GitDiffOptions, GitStatusResponse } from '../../types/git'

export interface GitDiffProvider {
  getFileDiff(repoId: number, filePath: string, database: Database, options?: GitDiffOptions): Promise<FileDiffResponse>
  getFullDiff(repoId: number, filePath: string, database: Database, options?: GitDiffOptions): Promise<FileDiffResponse>
}

export interface GitStatusProvider {
  getStatus(repoId: number, database: Database): Promise<GitStatusResponse>
}