import { toast } from 'sonner'

interface ToastOptions {
  duration?: number
  description?: string
  action?: {
    label: string
    onClick: () => void
  }
  id?: string | number
}

export const showToast = {
  success: (message: string, options?: ToastOptions) => {
    return toast.success(message, options)
  },
  
  error: (message: string, options?: ToastOptions) => {
    return toast.error(message, options)
  },
  
  info: (message: string, options?: ToastOptions) => {
    return toast.info(message, options)
  },
  
  warning: (message: string, options?: ToastOptions) => {
    return toast.warning(message, options)
  },
  
  loading: (message: string, options?: ToastOptions) => {
    return toast.loading(message, options)
  },
  
  dismiss: (id?: string | number) => {
    toast.dismiss(id)
  }
}

export type ShowToast = typeof showToast