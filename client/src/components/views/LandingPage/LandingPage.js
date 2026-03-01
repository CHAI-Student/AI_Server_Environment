/* eslint-disable no-console */ 

import React, { useState, useEffect } from 'react'

function LandingPage() {
  // 폴더 목록과 상태
  const [folders, setFolders] = useState([])
  const [loading, setLoading] = useState(false)
  const [responseMsg, setResponseMsg] = useState('')
  // pagination
  const [currentPage, setCurrentPage] = useState(0)
  const PAGE_SIZE = 20

  // 선택된 폴더 및 업로드 폼 상태
  const [selectedFolder, setSelectedFolder] = useState(null)
  const [trainProductIdx, setTrainProductIdx] = useState('')
  const [productEngName, setProductEngName] = useState('')
  const [zipFile, setZipFile] = useState(null)
  const [uploadLoading, setUploadLoading] = useState(false)
  const [uploadedFolders, setUploadedFolders] = useState(new Set()) // 업로드 완료한 폴더 추적
  const [deleteLoading, setDeleteLoading] = useState(new Set())
  const [pendingUploadFolder, setPendingUploadFolder] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)

  // 초기 로드: 모든 폴더 조회 + 로컬스토리지에서 업로드 상태 복원
  useEffect(() => {
    loadAllFolders()
    const saved = localStorage.getItem('uploadedFolders')
    if (saved) {
      try {
        const arr = JSON.parse(saved)
        if (Array.isArray(arr)) {
          setUploadedFolders(new Set(arr))
        }
      } catch {} // parsing 실패 시 무시
    }
  }, [])

  // NewAnnotation 경로의 모든 폴더 로드
  const loadAllFolders = async () => {
    try {
      setLoading(true)
      const response = await fetch('/api/annotation/list-all')
      const data = await response.json()

      if (data.success) {
        setFolders(data.folders || [])
        setResponseMsg(`${data.folders?.length || 0}개의 검수 대상 폴더를 찾았습니다`)
      } else {
        setResponseMsg(`폴더 로드 실패: ${data.err}`)
        setFolders([])
      }
    } catch (e) {
      setResponseMsg(`요청 실패: ${e.message}`)
      setFolders([])
    } finally {
      setLoading(false)
    }
  }

  // 폴더 선택
  const handleSelectFolder = (folder) => {
    setSelectedFolder(folder)
    // 자동 채우기: productEngName, trainProductIdx extracted from name
    setProductEngName(folder.productEngName || '')
    // robust extraction: ignore empty segments, productIdx is last, trainingProductIdx is first numeric segment
    const rawParts = String(folder.folderName || '').split('_');
    const parts = rawParts.filter((p) => p !== '');
    let inferredTrain = '';
    if (parts.length > 0) {
      const numeric = parts.find((p) => /^\d+$/.test(p));
      if (numeric) inferredTrain = numeric;
      else if (parts.length >= 2) inferredTrain = parts[1];
    }
    if (inferredTrain) setTrainProductIdx(inferredTrain)
    setZipFile(null)
  }

  // Zip 다운로드
  const handleDownloadZip = (folderName) => {
    const url = `/api/annotation/download-zip?folderName=${encodeURIComponent(folderName)}`
    const a = document.createElement('a')
    a.href = url
    a.download = `${folderName}.zip`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  // 검수 완료 클릭 -> 파일 선택 트리거
  const handleStartUploadForFolder = (folder) => {
    setPendingUploadFolder(folder)
    // 트리거될 숨김 파일 input에 포커스/클릭
    const el = document.getElementById('upload-zip-input')
    if (el) el.click()
  }

  // 검수 완료 파일 업로드
  const handleUploadVerified = async (fileToUpload = null) => {
    // 이 함수는 파일 선택 후 호출됩니다. pendingUploadFolder 사용
    const folder = pendingUploadFolder || selectedFolder
    if (!folder) {
      alert('업로드할 폴더가 없습니다. 폴더를 선택해주세요')
      return
    }
    const uploadFile = fileToUpload || zipFile
    if (!uploadFile) {
      alert('검수 완료 Zip 파일을 선택해주세요')
      return
    }

    // 파일 크기 검증 (500MB 제한)
    const MAX_FILE_SIZE = 500 * 1024 * 1024;
    if (uploadFile.size > MAX_FILE_SIZE) {
      alert(`파일 크기가 너무 큽니다 (최대 500MB, 현재: ${(uploadFile.size / 1024 / 1024).toFixed(2)}MB)`)
      return
    }

    // ZIP 파일 유효성 검증 (처음 4바이트 = PK\x03\x04)
    try {
      const header = await uploadFile.slice(0, 4).arrayBuffer()
      const headerView = new Uint8Array(header)
      if (headerView[0] !== 0x50 || headerView[1] !== 0x4B) {
        console.warn('[FILE_VALIDATE] Invalid ZIP header:', headerView)
        // 계속 진행하되 경고만 함
      }
    } catch (e) {
      console.error('[FILE_VALIDATE] Header check failed:', e.message)
    }

    // trainProductIdx와 productEngName은 폴더 정보에서 자동 추출
    const rawParts = String(folder.folderName || '').split('_');
    const parts = rawParts.filter((p) => p !== '');
    const productIdx = parts[parts.length - 1] || folder.productIdx || ''
    let trainingProductIdx = '';
    const numeric = parts.find((p) => /^\d+$/.test(p));
    if (numeric) trainingProductIdx = numeric;
    else if (parts.length >= 2) trainingProductIdx = parts[1];
    const productName = folder.productEngName || ''

    if (!trainingProductIdx || !productName) {
      alert('학습상품ID 또는 상품 영문명을 폴더 정보에서 가져올 수 없습니다')
      return
    }

    try {
      setUploadLoading(true)
      const formData = new FormData()
      formData.append('folderName', folder.folderName)
      formData.append('trainProductIdx', trainingProductIdx)
      formData.append('productEngName', productName)
      formData.append('zip', uploadFile)

      console.log('[UPLOAD] Starting upload with:', {
        folderName: folder.folderName,
        trainProductIdx: trainingProductIdx,
        productEngName: productName,
        fileName: uploadFile.name,
        fileSize: uploadFile.size,
        fileType: uploadFile.type,
      })

      const response = await fetch('/api/annotation/upload-verified', {
        method: 'POST',
        body: formData,
      })
      const data = await response.json()

      if (data.success) {
        setResponseMsg(`업로드 성공! ${data.uploadedCount}개 파일이 저장되었습니다`) 
        const newUploadedFolders = new Set(uploadedFolders)
        newUploadedFolders.add(folder.folderName)
        setUploadedFolders(newUploadedFolders)
        // 로컬 스토리지에 저장
        try { localStorage.setItem('uploadedFolders', JSON.stringify(Array.from(newUploadedFolders))) } catch {}
        // 초기화
        setZipFile(null)
        setPendingUploadFolder(null)
      } else {
        setResponseMsg(`업로드 실패: ${data.err}`)
      }
    } catch (e) {
      setResponseMsg(`요청 실패: ${e.message}`)
    } finally {
      setUploadLoading(false)
    }
  }

  // 원본 폴더 삭제 (업로드 완료 후)
  // 삭제 확인 모달을 통해 실행
  const handleRequestDelete = (folderName) => {
    setConfirmDelete(folderName)
  }

  const handleCancelDelete = () => {
    setConfirmDelete(null)
  }

  const handleConfirmDelete = async (folderName) => {
    try {
      const newDeleteLoading = new Set(deleteLoading)
      newDeleteLoading.add(folderName)
      setDeleteLoading(newDeleteLoading)

      const response = await fetch(
        `/api/annotation/delete-folder?folderName=${encodeURIComponent(folderName)}`,
        { method: 'DELETE' }
      )
      const data = await response.json()

      if (data.success) {
        setResponseMsg(`${folderName} 폴더 삭제 완료! (${data.deletedCount}개 파일 삭제)`)
        setFolders(folders.filter(f => f.folderName !== folderName))
        if (selectedFolder?.folderName === folderName) setSelectedFolder(null)
        // 삭제된 폴더 업로드 상태에서도 제거
        const newUploaded = new Set(uploadedFolders)
        newUploaded.delete(folderName)
        setUploadedFolders(newUploaded)
        try { localStorage.setItem('uploadedFolders', JSON.stringify(Array.from(newUploaded))) } catch {}
      } else {
        setResponseMsg(`삭제 실패: ${data.err}`)
      }
    } catch (e) {
      setResponseMsg(`요청 실패: ${e.message}`)
    } finally {
      const newDeleteLoading = new Set(deleteLoading)
      newDeleteLoading.delete(folderName)
      setDeleteLoading(newDeleteLoading)
      setConfirmDelete(null)
    }
  }

  // pages 계산 및 범위 좁히기
  const pageCount = Math.ceil(folders.length / PAGE_SIZE);
  useEffect(() => {
    if (currentPage >= pageCount) setCurrentPage(0);
  }, [pageCount]);

  const displayedFolders = folders.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE
  );

  return (
    <div style={{ width: '100vw', minHeight: '100vh', background: '#282828', padding: '20px', color: 'white', fontFamily: 'Helvetica, Arial, sans-serif' }}>
      {/* inline style로 hover 및 헤더 모서리 둥글게 처리 */}
      <style>{`
        .folder-row:hover { background: #333 !important; }
        th:first-child { border-top-left-radius: 8px; }
        th:last-child { border-top-right-radius: 8px; }
      `}</style>
      <p style={{ textAlign: 'center', fontSize: '30px', margin: '0 0 30px 0', color: 'white' }}>
        CHAI ANNOTATION
      </p>

      <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
        <div style={sectionStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h2 style={{ color: '#87ceeb', margin: 0 }}>검수 대상 폴더 관리</h2>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={loadAllFolders}
                disabled={loading}
                style={{ ...buttonStyle, background: '#4CAF50', padding: '8px 16px' }}
              >
                {loading ? '로드 중...' : '새로고침'}
              </button>
              <button
                onClick={async (e) => {
                  e.stopPropagation()
                  // 다운로드 처리
                  try {
                    const resp = await fetch('/api/annotation/download-labels')
                    if (!resp.ok) {
                      let errMsg = resp.statusText
                      try { const json = await resp.json(); if (json?.err) errMsg = json.err } catch {}
                      setResponseMsg(`다운로드 실패: ${errMsg}`)
                      return
                    }
                    const blob = await resp.blob()
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = 'annotation-labels.json'
                    document.body.appendChild(a)
                    a.click()
                    a.remove()
                    URL.revokeObjectURL(url)
                    setResponseMsg('annotation-labels.json 다운로드 완료')
                  } catch (err) {
                    setResponseMsg(`요청 실패: ${err?.message || String(err)}`)
                  }
                }}
                style={{ ...buttonStyle, background: '#607D8B', padding: '8px 16px' }}
              >
                어노테이션 라벨 다운로드
              </button>
            </div>
          </div>

          {folders.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
              <p>검수 대상 폴더가 없습니다.</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 2px 10px rgba(0,0,0,0.5)' }}>
            {/* 페이지네이션 계산 */}
            {folders.length > PAGE_SIZE && (
              <div style={{ margin: '10px 0', textAlign: 'center', color: '#ccc', fontSize: '13px' }}>
                <span>페이지 {currentPage + 1} / {Math.ceil(folders.length / PAGE_SIZE)} </span>
                <br />
                <button
                  onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                  disabled={currentPage === 0}
                  style={{ ...miniButtonStyle, marginRight: '8px' }}
                >Prev</button>
                {Array.from({ length: Math.ceil(folders.length / PAGE_SIZE) }, (_, i) => (
                  <button
                    key={i}
                    onClick={() => setCurrentPage(i)}
                    style={{
                      ...miniButtonStyle,
                      background: i === currentPage ? '#4CAF50' : '#888',
                      margin: '0 4px'
                    }}
                  >{i + 1}</button>
                ))}
                <button
                  onClick={() => setCurrentPage((p) => Math.min(p + 1, Math.ceil(folders.length / PAGE_SIZE) - 1))}
                  disabled={currentPage >= Math.ceil(folders.length / PAGE_SIZE) - 1}
                  style={{ ...miniButtonStyle, marginLeft: '8px' }}
                >Next</button>
              </div>
            )}
              <table style={tableStyle}>
                <thead>
                  <tr style={{ background: '#1a1a1a', borderBottom: '2px solid #555' }}>
                    <th style={thStyle}>폴더명</th>                    
                    <th style={thStyle}>상품ID</th>                    
                    <th style={thStyle}>상품 영문명</th>
                    <th style={thStyle}>파일 개수</th>
                    <th style={thStyle}>용량</th>
                    <th style={thStyle}>작업</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedFolders.map((folder, idx) => {
                    const isUploaded = uploadedFolders.has(folder.folderName)
                    const isDeleting = deleteLoading.has(folder.folderName)

                    return (
                      <tr
                        key={idx}
                        style={{
                          background: selectedFolder?.folderName === folder.folderName ? '#2a4a2a' : idx % 2 === 0 ? '#1a1a1a' : '#222',
                          cursor: 'pointer',
                          transition: 'background 0.2s'
                        }}
                        onClick={() => handleSelectFolder(folder)}
                      >
                        <td style={tdStyle}>
                          <span style={{ color: isUploaded ? '#4CAF50' : '#87ceeb', fontWeight: 'bold' }}>
                            {folder.folderName}
                          </span>
                        </td>
                        <td style={tdStyle}>{folder.productIdx || '-'}</td>
                        <td style={tdStyle}>{folder.productEngName || '-'}</td>
                        <td style={tdStyle}>{folder.fileCount}개</td>
                        <td style={tdStyle}>{(folder.totalSize / (1024 * 1024)).toFixed(1)}MB</td>
                        <td style={tdStyle}>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDownloadZip(folder.folderName)
                              }}
                              style={{ ...miniButtonStyle, background: '#2196F3' }}
                            >
                              다운로드
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                handleStartUploadForFolder(folder)
                              }}
                              disabled={uploadLoading || uploadedFolders.has(folder.folderName)}
                              style={{ ...miniButtonStyle, background: '#ff9800' }}
                            >
                              {uploadLoading && pendingUploadFolder?.folderName === folder.folderName ? '업로드 중...' : uploadedFolders.has(folder.folderName) ? '업로드 완료' : '검수 완료'}
                            </button>
                            {uploadedFolders.has(folder.folderName) && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleRequestDelete(folder.folderName)
                                }}
                                disabled={isDeleting}
                                style={{ ...miniButtonStyle, background: '#f44336' }}
                              >
                                {isDeleting ? '삭제 중...' : '삭제'}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 숨김 파일 입력: 테이블의 '검수 완료' 버튼에서 트리거 됩니다 */}
        <input
          id="upload-zip-input"
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0] || null
            if (!f) return
            console.log('[FILE_INPUT] File selected:', f.name, 'Size:', f.size, 'Type:', f.type)
            // 파일을 직접 전달하여 업로드 시작
            handleUploadVerified(f)
          }}
        />

        {/* 삭제 확인 모달 */}
        {confirmDelete && (
          <div style={{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ background: '#111', padding: '24px', borderRadius: '8px', width: '420px', color: 'white', boxShadow: '0 4px 20px rgba(0,0,0,0.6)' }}>
              <h3 style={{ marginTop: 0 }}>삭제하시겠습니까?</h3>
              <p style={{ color: '#ccc' }}>{confirmDelete} 폴더를 삭제하려면 아래에서 <strong>Yes</strong>를 눌러주세요.</p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                <button onClick={() => handleCancelDelete()} style={{ ...miniButtonStyle, background: '#777' }}>Cancel</button>
                <button onClick={() => handleConfirmDelete(confirmDelete)} style={{ ...miniButtonStyle, background: '#f44336' }}>Yes</button>
              </div>
            </div>
          </div>
        )}

        {/* 응답 메시지 */}
        {responseMsg && (
          <div style={{
            marginTop: '30px',
            padding: '15px',
            background: responseMsg.includes('✅') ? '#1b5e20' : responseMsg.includes('❌') ? '#b71c1c' : '#1a237e',
            border: '2px solid ' + (responseMsg.includes('✅') ? '#4CAF50' : responseMsg.includes('❌') ? '#f44336' : '#2196F3'),
            borderRadius: '5px',
            color: 'white',
            fontSize: '14px',
            wordBreak: 'break-word'
          }}>
            {responseMsg}
          </div>
        )}
      </div>
    </div>
  )
}

// 스타일 정의
const sectionStyle = {
  background: '#1a1a1a',
  border: '1px solid #444',
  borderRadius: '12px',
  padding: '25px',
  marginBottom: '30px',
  boxShadow: '0 4px 15px rgba(0,0,0,0.4)'
}

const tableStyle = {
  width: '100%',
  borderCollapse: 'separate',
  borderSpacing: '0 6px',
  fontSize: '14px',
}

const thStyle = {
  padding: '12px',
  textAlign: 'left',
  fontWeight: 'bold',
  color: '#87ceeb',
  borderBottom: '2px solid #555',
}

const tdStyle = {
  padding: '12px',
  borderBottom: '1px solid transparent',
  color: '#ddd',
  borderRadius: '6px',
}

// (이 컴포넌트에서는 사용되지 않는 스타일이라 주석 처리함)
/*
const inputGroupStyle = {
  marginBottom: '15px'
}

const inputStyle = {
  width: '100%',
  padding: '10px',
  marginTop: '5px',
  background: '#2a2a2a',
  border: '1px solid #555',
  borderRadius: '4px',
  color: 'white',
  fontSize: '14px',
  boxSizing: 'border-box'
}
*/

const buttonStyle = {
  padding: '12px 20px',
  border: 'none',
  borderRadius: '6px',
  color: 'white',
  fontSize: '14px',
  fontWeight: 'bold',
  cursor: 'pointer',
  transition: 'background 0.3s, opacity 0.3s',
  boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
}

const miniButtonStyle = {
  padding: '6px 12px',
  border: 'none',
  borderRadius: '4px',
  color: 'white',
  fontSize: '12px',
  fontWeight: 'bold',
  cursor: 'pointer',
  transition: 'background 0.2s, opacity 0.2s',
  boxShadow: '0 1px 4px rgba(0,0,0,0.3)'
}

export default LandingPage

