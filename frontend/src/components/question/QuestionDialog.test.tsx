import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QuestionDialog } from './QuestionDialog'

const mockRespondToQuestion = vi.fn()
const mockRejectQuestion = vi.fn()
const mockDismissDialog = vi.fn()

vi.mock('@/contexts/QuestionContext', () => ({
  useQuestionContext: vi.fn(() => mockContextValue),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, variant, ...props }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; variant?: string; [key: string]: unknown }) => (
    <button onClick={onClick} disabled={disabled} data-variant={variant} {...props}>
      {children}
    </button>
  ),
}))

vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({ checked, onCheckedChange, ...props }: { checked?: boolean; onCheckedChange?: () => void; [key: string]: unknown }) => (
    <input type="checkbox" checked={checked} onChange={onCheckedChange} {...props} />
  ),
}))

vi.mock('@/components/ui/input', () => ({
  Input: ({ value, onChange, placeholder, ...props }: { value?: string; onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void; placeholder?: string; [key: string]: unknown }) => (
    <input value={value} onChange={onChange} placeholder={placeholder} {...props} />
  ),
}))

vi.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
    <label {...props}>{children}</label>
  ),
}))

function makeQuestion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q-1',
    sessionID: 'sess-1',
    directory: '/test/dir',
    questions: [
      {
        question: 'Install Rust?',
        header: 'Dependencies',
        options: [
          { label: 'Yes, install Rust', description: 'Installs via rustup' },
          { label: 'No, skip', description: 'Skip installation' },
        ],
        multiple: false,
        custom: true,
      },
    ],
    tool: { messageID: 'msg-1', callID: 'call-1' },
    ...overrides,
  }
}

let mockContextValue: Record<string, unknown>

function setMockContext(overrides: Record<string, unknown> = {}) {
  mockContextValue = {
    currentQuestion: makeQuestion(),
    pendingQuestions: [makeQuestion()],
    respondToQuestion: mockRespondToQuestion,
    rejectQuestion: mockRejectQuestion,
    addQuestion: vi.fn(),
    removeQuestion: vi.fn(),
    dismissDialog: mockDismissDialog,
    isDialogDismissed: false,
    ...overrides,
  }
}

describe('QuestionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setMockContext()
  })

  it('should not render when there is no current question', () => {
    setMockContext({ currentQuestion: null, pendingQuestions: [] })
    const { container } = render(<QuestionDialog />)
    expect(container.firstChild).toBeNull()
  })

  it('should not render when dialog is dismissed', () => {
    setMockContext({ isDialogDismissed: true })
    const { container } = render(<QuestionDialog />)
    expect(container.firstChild).toBeNull()
  })

  it('should render question header and text', () => {
    render(<QuestionDialog />)
    expect(screen.getByText('Dependencies')).toBeInTheDocument()
    expect(screen.getByText('Install Rust?')).toBeInTheDocument()
  })

  it('should render all options', () => {
    render(<QuestionDialog />)
    expect(screen.getByText('Yes, install Rust')).toBeInTheDocument()
    expect(screen.getByText('No, skip')).toBeInTheDocument()
    expect(screen.getByText('Installs via rustup')).toBeInTheDocument()
    expect(screen.getByText('Skip installation')).toBeInTheDocument()
  })

  it('should render Submit and Skip buttons', () => {
    render(<QuestionDialog />)
    expect(screen.getByText('Submit')).toBeInTheDocument()
    expect(screen.getByText('Skip')).toBeInTheDocument()
  })

  it('should call dismissDialog when X button is clicked', async () => {
    const user = userEvent.setup()
    render(<QuestionDialog />)

    const dismissButton = screen.getByTitle('Dismiss dialog (answer inline instead)')
    await user.click(dismissButton)

    expect(mockDismissDialog).toHaveBeenCalledTimes(1)
    expect(mockRejectQuestion).not.toHaveBeenCalled()
  })

  it('should call rejectQuestion when Skip is clicked', async () => {
    mockRejectQuestion.mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    render(<QuestionDialog />)

    await user.click(screen.getByText('Skip'))

    expect(mockRejectQuestion).toHaveBeenCalledWith('q-1')
  })

  it('should show error when submitting without selection', async () => {
    const user = userEvent.setup()
    render(<QuestionDialog />)

    await user.click(screen.getByText('Submit'))

    expect(screen.getByText('Please select at least one option or provide a custom answer')).toBeInTheDocument()
    expect(mockRespondToQuestion).not.toHaveBeenCalled()
  })

  it('should select an option and submit', async () => {
    mockRespondToQuestion.mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    render(<QuestionDialog />)

    await user.click(screen.getByText('Yes, install Rust'))
    await user.click(screen.getByText('Submit'))

    expect(mockRespondToQuestion).toHaveBeenCalledWith('q-1', [['Yes, install Rust']])
  })

  it('should show custom answer input when custom is not false', () => {
    render(<QuestionDialog />)
    expect(screen.getByPlaceholderText('Type your answer...')).toBeInTheDocument()
  })

  it('should not show custom answer input when custom is false', () => {
    setMockContext({
      currentQuestion: makeQuestion({
        questions: [
          {
            question: 'Pick one',
            header: 'Choice',
            options: [{ label: 'A', description: 'Option A' }],
            custom: false,
          },
        ],
      }),
      pendingQuestions: [makeQuestion()],
    })
    render(<QuestionDialog />)
    expect(screen.queryByPlaceholderText('Type your answer...')).not.toBeInTheDocument()
  })

  it('should show pending count badge when multiple questions exist', () => {
    setMockContext({
      pendingQuestions: [makeQuestion(), makeQuestion({ id: 'q-2' })],
    })
    render(<QuestionDialog />)
    expect(screen.getByText('+1 more')).toBeInTheDocument()
  })

  it('should show error when API fails during submit', async () => {
    mockRespondToQuestion.mockRejectedValueOnce(new Error('Network error'))
    const user = userEvent.setup()
    render(<QuestionDialog />)

    await user.click(screen.getByText('Yes, install Rust'))
    await user.click(screen.getByText('Submit'))

    expect(screen.getByText('Network error')).toBeInTheDocument()
  })
})
