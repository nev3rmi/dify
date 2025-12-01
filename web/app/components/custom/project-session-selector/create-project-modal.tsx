'use client'

import type { FC } from 'react'
import React, { useState } from 'react'
import Modal from '@/app/components/base/modal'
import Button from '@/app/components/base/button'
import Input from '@/app/components/base/input'

export type CreateProjectModalProps = {
  isShow: boolean
  isLoading: boolean
  onClose: () => void
  onSave: (projectKey: string) => void
}

const CreateProjectModal: FC<CreateProjectModalProps> = ({
  isShow,
  isLoading,
  onClose,
  onSave,
}) => {
  const [projectKey, setProjectKey] = useState('')

  const handleSave = () => {
    if (projectKey.trim()) {
      onSave(projectKey.trim())
      setProjectKey('')
    }
  }

  const handleClose = () => {
    setProjectKey('')
    onClose()
  }

  return (
    <Modal
      title="Create New Project"
      isShow={isShow}
      onClose={handleClose}
    >
      <div className='mt-6 text-sm font-medium leading-[21px] text-text-primary'>Project Key</div>
      <Input
        className='mt-2 h-10 w-full'
        value={projectKey}
        onChange={e => setProjectKey(e.target.value)}
        placeholder='Enter project key (e.g., my-project)'
        onKeyDown={e => e.key === 'Enter' && handleSave()}
      />

      <div className='mt-10 flex justify-end'>
        <Button className='mr-2 shrink-0' onClick={handleClose}>Cancel</Button>
        <Button
          variant='primary'
          className='shrink-0'
          onClick={handleSave}
          loading={isLoading}
          disabled={!projectKey.trim()}
        >
          Create
        </Button>
      </div>
    </Modal>
  )
}

export default React.memo(CreateProjectModal)
