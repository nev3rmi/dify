'use client'

import type { FC } from 'react'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { RiDeleteBinLine, RiFileTextLine, RiRefreshLine, RiUploadLine } from '@remixicon/react'
import Modal from '@/app/components/base/modal'
import Button from '@/app/components/base/button'

const PROJECT_FILES_API = 'https://n8n.toho.vn/webhook/ememory/get-project-items-list'
const PROJECT_UPLOAD_API = 'https://n8n.toho.vn/webhook/ememory/upload-project-item'
const PROJECT_DELETE_API = 'https://n8n.toho.vn/webhook/ememory/delete-project-item'

type MinioFile = {
  Key: string
  LastModified: string
  ETag: string
  Size: string
  StorageClass: string
}

export type KnowledgeModalProps = {
  isShow: boolean
  projectKey: string
  onClose: () => void
}

// Format file size to human readable
const formatFileSize = (bytes: string): string => {
  const size = parseInt(bytes, 10)
  if (size < 1024)
    return `${size} B`
  if (size < 1024 * 1024)
    return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

// Extract filename from full path
const getFileName = (key: string): string => {
  const parts = key.split('/')
  return parts[parts.length - 1]
}

// Format date
const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr)
  return date.toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

const KnowledgeModal: FC<KnowledgeModalProps> = ({
  isShow,
  projectKey,
  onClose,
}) => {
  const [files, setFiles] = useState<MinioFile[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const fetchFiles = useCallback(async () => {
    if (!projectKey)
      return

    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch(PROJECT_FILES_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ project_code: projectKey }),
      })
      const data = await response.json()
      if (Array.isArray(data)) {
        // Filter out .anchor files
        const filteredFiles = data.filter((file: MinioFile) => !file.Key.includes('.anchor'))
        setFiles(filteredFiles)
      }
      else {
        setFiles([])
      }
    }
    catch (err) {
      console.error('[KnowledgeModal] Failed to fetch files:', err)
      setError('Failed to load files')
      setFiles([])
    }
    finally {
      setIsLoading(false)
    }
  }, [projectKey])

  // Upload file
  const uploadFile = useCallback(async (file: File) => {
    if (!projectKey)
      return

    setIsUploading(true)
    setError(null)
    try {
      const formData = new FormData()
      formData.append('project_code', projectKey)
      formData.append('data', file)

      const response = await fetch(PROJECT_UPLOAD_API, {
        method: 'POST',
        body: formData,
      })

      if (!response.ok)
        throw new Error('Upload failed')

      // Refresh file list after upload
      await fetchFiles()
    }
    catch (err) {
      console.error('[KnowledgeModal] Failed to upload file:', err)
      setError('Failed to upload file')
    }
    finally {
      setIsUploading(false)
      // Reset file input
      if (fileInputRef.current)
        fileInputRef.current.value = ''
    }
  }, [projectKey, fetchFiles])

  // Delete file
  const deleteFile = useCallback(async (fileKey: string) => {
    if (!projectKey)
      return

    if (!confirm(`Are you sure you want to delete "${getFileName(fileKey)}"?`))
      return

    try {
      const response = await fetch(PROJECT_DELETE_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          project_code: projectKey,
          file_key: fileKey,
        }),
      })

      if (!response.ok)
        throw new Error('Delete failed')

      // Refresh file list after delete
      await fetchFiles()
    }
    catch (err) {
      console.error('[KnowledgeModal] Failed to delete file:', err)
      setError('Failed to delete file')
    }
  }, [projectKey, fetchFiles])

  // Handle file input change
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file)
      uploadFile(file)
  }, [uploadFile])

  // Trigger file input click
  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  // Fetch files when modal opens or project changes
  useEffect(() => {
    if (isShow && projectKey)
      fetchFiles()
  }, [isShow, projectKey, fetchFiles])

  return (
    <Modal
      title={`Knowledge Base${projectKey ? ` - ${projectKey}` : ''}`}
      isShow={isShow}
      onClose={onClose}
      className='!max-w-[600px]'
    >
      <div className='mt-4 min-h-[200px]'>
        {!projectKey
          ? (
            <div className='flex h-[200px] items-center justify-center text-text-tertiary'>
              Please select a project first
            </div>
          )
          : (
            <div className='space-y-3'>
              <div className='flex items-center justify-between'>
                <div className='text-sm text-text-secondary'>
                  Files in project: <span className='font-medium'>{projectKey}</span>
                </div>
                <div className='flex items-center gap-2'>
                  <input
                    ref={fileInputRef}
                    type='file'
                    className='hidden'
                    onChange={handleFileChange}
                  />
                  <Button
                    variant='primary'
                    size='small'
                    onClick={handleUploadClick}
                    disabled={isUploading}
                  >
                    <RiUploadLine className={`mr-1 h-3.5 w-3.5 ${isUploading ? 'animate-pulse' : ''}`} />
                    {isUploading ? 'Uploading...' : 'Upload'}
                  </Button>
                  <Button
                    variant='secondary'
                    size='small'
                    onClick={fetchFiles}
                    disabled={isLoading}
                  >
                    <RiRefreshLine className={`mr-1 h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                    Refresh
                  </Button>
                </div>
              </div>

              {isLoading && (
                <div className='flex h-[160px] items-center justify-center text-text-tertiary'>
                  Loading files...
                </div>
              )}

              {error && (
                <div className='flex h-[160px] items-center justify-center text-text-destructive'>
                  {error}
                </div>
              )}

              {!isLoading && !error && files.length === 0 && (
                <div className='flex h-[160px] items-center justify-center rounded-lg border border-dashed border-divider-regular bg-components-input-bg-normal text-text-tertiary'>
                  No files found in this project
                </div>
              )}

              {!isLoading && !error && files.length > 0 && (
                <div className='max-h-[300px] overflow-y-auto rounded-lg border border-divider-regular'>
                  {files.map((file, index) => (
                    <div
                      key={file.Key}
                      className={`group flex items-center gap-3 px-3 py-2.5 ${index !== files.length - 1 ? 'border-b border-divider-subtle' : ''} hover:bg-state-base-hover`}
                    >
                      <RiFileTextLine className='h-5 w-5 shrink-0 text-text-tertiary' />
                      <div className='min-w-0 flex-1'>
                        <div className='truncate text-sm font-medium text-text-secondary' title={file.Key}>
                          {getFileName(file.Key)}
                        </div>
                        <div className='flex items-center gap-2 text-xs text-text-tertiary'>
                          <span>{formatFileSize(file.Size)}</span>
                          <span>•</span>
                          <span>{formatDate(file.LastModified)}</span>
                        </div>
                      </div>
                      <div
                        onClick={() => deleteFile(file.Key)}
                        className='flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded opacity-0 transition-opacity hover:bg-state-destructive-hover group-hover:opacity-100'
                        title='Delete file'
                      >
                        <RiDeleteBinLine className='h-4 w-4 text-text-tertiary hover:text-text-destructive' />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className='text-xs text-text-quaternary'>
                {files.length} file{files.length !== 1 ? 's' : ''} in bucket
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
