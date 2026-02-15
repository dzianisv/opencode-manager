import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToolCallPart } from './ToolCallPart'

const mockRespondToQuestion = vi.fn()
const mockRejectQuestion = vi.fn()
const mockGetPermissionForCallID = vi.fn(() => undefined)

vi.mock('@/hooks/useSettings', () => ({
  useSettings: vi.fn(() => ({
    preferences: { expandToolCalls: false },
  })),
}))

vi.mock('@/stores/userBashStore', () => ({
  useUserBash: vi.fn(() => ({
    userBashCommands: new Set(),
  })),
}))

vi.mock('@/contexts/PermissionContext', () => ({
  usePermissionContext: vi.fn(() => ({
    getPermissionForCallID: mockGetPermissionForCallID,
  })),
}))

vi.mock('@/contexts/QuestionContext', () => ({
  useQuestionContext: vi.fn(() => ({
    pendingQuestions: mockPendingQuestions,
    respondToQuestion: mockRespondToQuestion,
    rejectQuestion: mockRejectQuestion,
  })),
}))

vi.mock('./FileToolRender', () => ({
  getToolSpecificRender: vi.fn(() => null),
}))

vi.mock('@/lib/fileReferences', () => ({
  detectFileReferences: vi.fn(() => []),
}))

let mockPendingQuestions: Array<{ id: string; tool?: { callID: string; messageID: string }; sessionID: string; directory?: string; questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiple?: boolean }> }> = []

function makeQuestionPart(overrides: Record<string, unknown> = {}) {
  return {
    id: 'part-1',
    type: 'tool' as const,
    tool: 'question',
    callID: 'call-1',
    sessionID: 'sess-1',
    state: {
      status: 'running' as const,
      input: {
        questions: [
          {
            question: 'Install Rust?',
            header: 'Dependencies',
            options: [
              { label: 'Yes, install Rust', description: 'Installs via rustup' },
              { label: 'No, skip', description: 'Skip installation' },
            ],
            multiple: false,
            custom: false,
          },
        ],
      },
    },
    ...overrides,
  }
}

function makeMatchingQuestion() {
  return {
    id: 'q-1',
    sessionID: 'sess-1',
    directory: '/test/dir',
    tool: { callID: 'call-1', messageID: 'msg-1' },
    questions: [
      {
        question: 'Install Rust?',
        header: 'Dependencies',
        options: [
          { label: 'Yes, install Rust', description: 'Installs via rustup' },
          { label: 'No, skip', description: 'Skip installation' },
        ],
        multiple: false,
      },
    ],
  }
}

describe('ToolCallPart - Question Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPendingQuestions = []
  })

  it('should render question UI for running question tool', () => {
    mockPendingQuestions = [makeMatchingQuestion()]
    render(<ToolCallPart part={makeQuestionPart() as never} />)

    expect(screen.getByText('Question awaiting your answer')).toBeInTheDocument()
    expect(screen.getByText('Dependencies')).toBeInTheDocument()
    expect(screen.getByText('Install Rust?')).toBeInTheDocument()
  })

  it('should render all options as buttons', () => {
    mockPendingQuestions = [makeMatchingQuestion()]
    render(<ToolCallPart part={makeQuestionPart() as never} />)

    expect(screen.getByText('Yes, install Rust')).toBeInTheDocument()
    expect(screen.getByText('No, skip')).toBeInTheDocument()
    expect(screen.getByText('Installs via rustup')).toBeInTheDocument()
  })

  it('should show Submit and Skip buttons when matching question exists', () => {
    mockPendingQuestions = [makeMatchingQuestion()]
    render(<ToolCallPart part={makeQuestionPart() as never} />)

    expect(screen.getByText('Submit')).toBeInTheDocument()
    expect(screen.getByText('Skip')).toBeInTheDocument()
  })

  it('should show Loading when no matching question found', () => {
    mockPendingQuestions = []
    render(<ToolCallPart part={makeQuestionPart() as never} />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('Submit')).not.toBeInTheDocument()
    expect(screen.queryByText('Skip')).not.toBeInTheDocument()
  })

  it('should disable option buttons when no matching question', () => {
    mockPendingQuestions = []
    render(<ToolCallPart part={makeQuestionPart() as never} />)

    const buttons = screen.getAllByRole('button')
    buttons.forEach((btn) => {
      expect(btn).toBeDisabled()
    })
  })

  it('should select an option on click', async () => {
    mockPendingQuestions = [makeMatchingQuestion()]
    const user = userEvent.setup()
    render(<ToolCallPart part={makeQuestionPart() as never} />)

    await user.click(screen.getByText('Yes, install Rust'))

    const optionButton = screen.getByText('Yes, install Rust').closest('button')!
    expect(optionButton.className).toContain('border-blue-500')
  })

  it('should deselect option in single-select mode when clicking different option', async () => {
    mockPendingQuestions = [makeMatchingQuestion()]
    const user = userEvent.setup()
    render(<ToolCallPart part={makeQuestionPart() as never} />)

    await user.click(screen.getByText('Yes, install Rust'))
    await user.click(screen.getByText('No, skip'))

    const yesButton = screen.getByText('Yes, install Rust').closest('button')!
    const noButton = screen.getByText('No, skip').closest('button')!
    expect(yesButton.className).toContain('border-border')
    expect(noButton.className).toContain('bg-blue-500/10')
  })

  it('should submit selected answer', async () => {
    mockPendingQuestions = [makeMatchingQuestion()]
    mockRespondToQuestion.mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    render(<ToolCallPart part={makeQuestionPart() as never} />)

    await user.click(screen.getByText('Yes, install Rust'))
    await user.click(screen.getByText('Submit'))

    expect(mockRespondToQuestion).toHaveBeenCalledWith('q-1', [['Yes, install Rust']])
  })

  it('should show error when submitting without selection', async () => {
    mockPendingQuestions = [makeMatchingQuestion()]
    const user = userEvent.setup()
    render(<ToolCallPart part={makeQuestionPart() as never} />)

    await user.click(screen.getByText('Submit'))

    expect(screen.getByText('Please select at least one option')).toBeInTheDocument()
    expect(mockRespondToQuestion).not.toHaveBeenCalled()
  })

  it('should reject question when Skip is clicked', async () => {
    mockPendingQuestions = [makeMatchingQuestion()]
    mockRejectQuestion.mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    render(<ToolCallPart part={makeQuestionPart() as never} />)

    await user.click(screen.getByText('Skip'))

    expect(mockRejectQuestion).toHaveBeenCalledWith('q-1')
  })

  it('should show error when submit fails', async () => {
    mockPendingQuestions = [makeMatchingQuestion()]
    mockRespondToQuestion.mockRejectedValueOnce(new Error('Network error'))
    const user = userEvent.setup()
    render(<ToolCallPart part={makeQuestionPart() as never} />)

    await user.click(screen.getByText('Yes, install Rust'))
    await user.click(screen.getByText('Submit'))

    expect(screen.getByText('Network error')).toBeInTheDocument()
  })

  it('should render completed question state', () => {
    const part = makeQuestionPart({
      state: {
        status: 'completed',
        input: { questions: [] },
        output: 'Selected: Yes, install Rust',
      },
    })

    render(<ToolCallPart part={part as never} />)

    expect(screen.getByText('Question answered')).toBeInTheDocument()
    expect(screen.getByText('Selected: Yes, install Rust')).toBeInTheDocument()
  })

  it('should render error question state', () => {
    const part = makeQuestionPart({
      state: {
        status: 'error',
        input: { questions: [] },
        error: 'User rejected',
      },
    })

    render(<ToolCallPart part={part as never} />)

    expect(screen.getByText('Question rejected')).toBeInTheDocument()
    expect(screen.getByText('User rejected')).toBeInTheDocument()
  })

  it('should support multiple selection when multiple=true', async () => {
    const multiQuestion = makeMatchingQuestion()
    multiQuestion.questions[0].multiple = true

    const part = makeQuestionPart({
      state: {
        status: 'running',
        input: {
          questions: [
            {
              ...multiQuestion.questions[0],
              multiple: true,
            },
          ],
        },
      },
    })

    mockPendingQuestions = [multiQuestion]
    mockRespondToQuestion.mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    render(<ToolCallPart part={part as never} />)

    await user.click(screen.getByText('Yes, install Rust'))
    await user.click(screen.getByText('No, skip'))

    const yesButton = screen.getByText('Yes, install Rust').closest('button')!
    const noButton = screen.getByText('No, skip').closest('button')!
    expect(yesButton.className).toContain('border-blue-500')
    expect(noButton.className).toContain('border-blue-500')

    await user.click(screen.getByText('Submit'))

    expect(mockRespondToQuestion).toHaveBeenCalledWith('q-1', [['Yes, install Rust', 'No, skip']])
  })

  it('should toggle off an option in multi-select mode', async () => {
    const multiQuestion = makeMatchingQuestion()
    multiQuestion.questions[0].multiple = true

    const part = makeQuestionPart({
      state: {
        status: 'running',
        input: {
          questions: [
            {
              ...multiQuestion.questions[0],
              multiple: true,
            },
          ],
        },
      },
    })

    mockPendingQuestions = [multiQuestion]
    const user = userEvent.setup()
    render(<ToolCallPart part={part as never} />)

    await user.click(screen.getByText('Yes, install Rust'))
    const yesButton = screen.getByText('Yes, install Rust').closest('button')!
    expect(yesButton.className).toContain('border-blue-500')

    await user.click(screen.getByText('Yes, install Rust'))
    expect(yesButton.className).toContain('border-border')
  })
})

describe('ToolCallPart - Non-question tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPendingQuestions = []
  })

  it('should render bash tool with command preview', () => {
    const part = {
      id: 'part-2',
      type: 'tool' as const,
      tool: 'bash',
      callID: 'call-2',
      sessionID: 'sess-1',
      state: {
        status: 'completed' as const,
        input: { command: 'echo hello' },
        output: 'hello',
        time: { start: 1000, end: 2000 },
      },
    }

    render(<ToolCallPart part={part as never} />)

    expect(screen.getByText('bash')).toBeInTheDocument()
    expect(screen.getByText('echo hello')).toBeInTheDocument()
  })

  it('should show pending status for pending tool', () => {
    const part = {
      id: 'part-3',
      type: 'tool' as const,
      tool: 'read',
      callID: 'call-3',
      sessionID: 'sess-1',
      state: {
        status: 'pending' as const,
      },
    }

    render(<ToolCallPart part={part as never} />)

    expect(screen.getByText('read')).toBeInTheDocument()
    expect(screen.getByText('(pending)')).toBeInTheDocument()
  })
})
