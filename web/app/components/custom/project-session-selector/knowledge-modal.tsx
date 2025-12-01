'use client'

import type { FC } from 'react'
import React from 'react'
import Modal from '@/app/components/base/modal'
import Button from '@/app/components/base/button'

export type KnowledgeModalProps = {
  isShow: boolean
  projectKey: string
  onClose: () => void
}

const KnowledgeModal: FC<KnowledgeModalProps> = ({
  isShow,
  projectKey,
  onClose,
}) => {
  // TODO: Fetch files from MinIO for the selected project

  return (
    <Modal
      title={`Knowledge Base${projectKey ? ` - ${projectKey}` : ''}`}
      isShow={isShow}
      onClose={onClose}
      className='!max-w-[600px]'
    >
      <div className='mt-6 min-h-[200px]'>
        {!projectKey
          ? (
            <div className='flex h-[200px] items-center justify-center text-text-tertiary'>
              Please select a project first
            </div>
          )
          : (
            <div className='space-y-3'>
              <div className='text-sm text-text-secondary'>
                Files in project: <span className='font-medium'>{projectKey}</span>
              </div>
              <div className='flex h-[160px] items-center justify-center rounded-lg border border-dashed border-divider-regular bg-components-input-bg-normal text-text-tertiary'>
                {/* TODO: File list from MinIO will be displayed here */}
                Loading files from MinIO...
              </div>
            </div>
          )}
      </div>

      <div className='mt-6 flex justify-end'>
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  )
}

export default React.memo(KnowledgeModal)
