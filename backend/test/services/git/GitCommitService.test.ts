import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest'
import type { Database } from 'bun:sqlite'
import type { GitAuthService } from '../../../src/services/git-auth'

vi.mock('bun:sqlite', () => ({
  Database: vi.fn()
}))

vi.mock('../../../src/services/settings', () => ({
  SettingsService: vi.fn().mockImplementation(() => ({
    getSettings: vi.fn().mockReturnValue({
      preferences: {
        gitIdentity: null,
        gitCredentials: [],
      },
    }),
  })),
}))

vi.mock('../../../src/utils/process', () => ({
  executeCommand: vi.fn(),
}))

vi.mock('../../../src/db/queries', () => ({
  getRepoById: vi.fn(),
}))

vi.mock('../../../src/utils/git-auth', () => ({
  resolveGitIdentity: vi.fn().mockResolvedValue(null),
  createGitIdentityEnv: vi.fn().mockReturnValue({}),
  createSilentGitEnv: vi.fn(),
}))

import { GitCommitService } from '../../../src/services/git/GitCommitService'
import { executeCommand } from '../../../src/utils/process'
import { getRepoById } from '../../../src/db/queries'

const executeCommandMock = executeCommand as MockedFunction<typeof executeCommand>
const getRepoByIdMock = getRepoById as MockedFunction<typeof getRepoById>

describe('GitCommitService', () => {
  let service: GitCommitService
  let database: Database
  let mockGitAuthService: GitAuthService

  beforeEach(() => {
    vi.clearAllMocks()
    database = {} as Database
    mockGitAuthService = {
      getGitEnvironment: vi.fn().mockReturnValue({}),
    } as unknown as GitAuthService
    service = new GitCommitService(mockGitAuthService)
  })

  describe('commit', () => {
    it('commits staged changes with message', async () => {
      const mockRepo = {
        id: 1,
        fullPath: '/path/to/repo',
      }
      getRepoByIdMock.mockReturnValue(mockRepo as any)
      executeCommandMock.mockResolvedValue('[main abc1234] Test commit\n 1 file changed')

      const result = await service.commit(1, 'Test commit', database)

      expect(getRepoByIdMock).toHaveBeenCalledWith(database, 1)
      expect(executeCommandMock).toHaveBeenCalledWith(
        ['git', '-C', mockRepo.fullPath, 'commit', '-m', 'Test commit'],
        { env: expect.any(Object) }
      )
      expect(result).toBe('[main abc1234] Test commit\n 1 file changed')
    })

    it('commits specific staged files', async () => {
      const mockRepo = {
        id: 1,
        fullPath: '/path/to/repo',
      }
      getRepoByIdMock.mockReturnValue(mockRepo as any)
      executeCommandMock.mockResolvedValue('[main abc1234] Commit specific files\n 2 files changed')

      const result = await service.commit(1, 'Commit specific files', database, ['file1.ts', 'file2.ts'])

      expect(executeCommandMock).toHaveBeenCalledWith(
        ['git', '-C', mockRepo.fullPath, 'commit', '-m', 'Commit specific files', '--', 'file1.ts', 'file2.ts'],
        { env: expect.any(Object) }
      )
      expect(result).toBe('[main abc1234] Commit specific files\n 2 files changed')
    })

    it('throws error when repository not found', async () => {
      getRepoByIdMock.mockReturnValue(null)

      await expect(service.commit(999, 'Test', database)).rejects.toThrow('Repository not found')
    })

    it('throws error when commit command fails', async () => {
      const mockRepo = {
        id: 1,
        fullPath: '/path/to/repo',
      }
      getRepoByIdMock.mockReturnValue(mockRepo as any)
      executeCommandMock.mockRejectedValue(new Error('Nothing to commit'))

      await expect(service.commit(1, 'Test', database)).rejects.toThrow('Nothing to commit')
    })
  })

  describe('stageFiles', () => {
    it('stages files', async () => {
      const mockRepo = {
        id: 1,
        fullPath: '/path/to/repo',
      }
      getRepoByIdMock.mockReturnValue(mockRepo as any)
      executeCommandMock.mockResolvedValue('')

      const result = await service.stageFiles(1, ['file1.ts', 'file2.ts'], database)

      expect(getRepoByIdMock).toHaveBeenCalledWith(database, 1)
      expect(executeCommandMock).toHaveBeenCalledWith(
        ['git', '-C', mockRepo.fullPath, 'add', '--', 'file1.ts', 'file2.ts'],
        { env: expect.any(Object) }
      )
      expect(result).toBe('')
    })

    it('returns early when no files to stage', async () => {
      const result = await service.stageFiles(1, [], database)

      expect(executeCommandMock).not.toHaveBeenCalled()
      expect(result).toBe('')
    })

    it('throws error when repository not found', async () => {
      getRepoByIdMock.mockReturnValue(null)

      await expect(service.stageFiles(999, ['file.ts'], database)).rejects.toThrow('Repository not found')
    })

    it('throws error when stage command fails', async () => {
      const mockRepo = {
        id: 1,
        fullPath: '/path/to/repo',
      }
      getRepoByIdMock.mockReturnValue(mockRepo as any)
      executeCommandMock.mockRejectedValue(new Error('Pathspec error'))

      await expect(service.stageFiles(1, ['invalid.txt'], database)).rejects.toThrow('Pathspec error')
    })
  })

  describe('unstageFiles', () => {
    it('unstages files', async () => {
      const mockRepo = {
        id: 1,
        fullPath: '/path/to/repo',
      }
      getRepoByIdMock.mockReturnValue(mockRepo as any)
      executeCommandMock.mockResolvedValue('')

      const result = await service.unstageFiles(1, ['file1.ts', 'file2.ts'], database)

      expect(getRepoByIdMock).toHaveBeenCalledWith(database, 1)
      expect(executeCommandMock).toHaveBeenCalledWith(
        ['git', '-C', mockRepo.fullPath, 'restore', '--staged', '--', 'file1.ts', 'file2.ts'],
        { env: expect.any(Object) }
      )
      expect(result).toBe('')
    })

    it('returns early when no files to unstage', async () => {
      const result = await service.unstageFiles(1, [], database)

      expect(executeCommandMock).not.toHaveBeenCalled()
      expect(result).toBe('')
    })

    it('throws error when repository not found', async () => {
      getRepoByIdMock.mockReturnValue(null)

      await expect(service.unstageFiles(999, ['file.ts'], database)).rejects.toThrow('Repository not found')
    })

    it('throws error when unstage command fails', async () => {
      const mockRepo = {
        id: 1,
        fullPath: '/path/to/repo',
      }
      getRepoByIdMock.mockReturnValue(mockRepo as any)
      executeCommandMock.mockRejectedValue(new Error('Error unstaging'))

      await expect(service.unstageFiles(1, ['file.ts'], database)).rejects.toThrow('Error unstaging')
    })
  })

  describe('resetToCommit', () => {
    it('resets to specific commit', async () => {
      const mockRepo = {
        id: 1,
        fullPath: '/path/to/repo',
      }
      getRepoByIdMock.mockReturnValue(mockRepo as any)
      executeCommandMock.mockResolvedValue('HEAD is now at abc123')

      const result = await service.resetToCommit(1, 'abc123', database)

      expect(getRepoByIdMock).toHaveBeenCalledWith(database, 1)
      expect(executeCommandMock).toHaveBeenCalledWith(
        ['git', '-C', mockRepo.fullPath, 'reset', '--hard', 'abc123'],
        { env: expect.any(Object) }
      )
      expect(result).toBe('HEAD is now at abc123')
    })

    it('throws error when repository not found', async () => {
      getRepoByIdMock.mockReturnValue(null)

      await expect(service.resetToCommit(999, 'abc123', database)).rejects.toThrow('Repository not found')
    })

    it('throws error when reset command fails', async () => {
      const mockRepo = {
        id: 1,
        fullPath: '/path/to/repo',
      }
      getRepoByIdMock.mockReturnValue(mockRepo as any)
      executeCommandMock.mockRejectedValue(new Error('Invalid commit hash'))

      await expect(service.resetToCommit(1, 'invalid', database)).rejects.toThrow('Invalid commit hash')
    })
  })
})
