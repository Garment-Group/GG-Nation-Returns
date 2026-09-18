/**
 * Supabase Edge Function — extensiv-proxy v4
 *
 * GET /extensiv-proxy              → serve full list from cache (instant)
 * GET /extensiv-proxy?refresh=1    → incremental refresh (last 7 days) — for cron
 * GET /extensiv-proxy?full=1       → full refresh (Apr 7 onwards) — manual only
 * GET /extensiv-proxy?id=123       → single receiver full detail
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BASE_URL    = 'https://secure-wms.com'
const CUSTOMER_ID = 93
const PAGE_SIZE   = 100

const RECEIVER_KEY      = 'http://api.3plCentral.com/rels/inventory/receiver'
const RECEIVER_ITEM_KEY = 'http://api.3plCentral.com/rels/inventory/receiveritem'
const STATUS_OPEN       = 0

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

let cachedToken = ''
let tokenExpiry = 0

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken
  const id  = Deno.env.get('EXTENSIV_CLIENT_ID')!
  const sec = Deno.env.get('EXTENSIV_CLIENT_SECRET')!
  const usr = Deno.env.get('EXTENSIV_USER_LOGIN')!
  const res = await fetch(`${BASE_URL}/AuthServer/api/Token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${id}:${sec}`)}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify({ grant_type: 'client_credentials', user_login: usr }),
  })
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`)
  const d     = await res.json()
  cachedToken = d.access_token
  tokenExpiry = Date.now() + (d.expires_in > 0 ? d.expires_in : 1800) * 1000
  return cachedToken
}

async function fetchPage(token: string, pgnum: number, dateFrom: string) {
  const url = new URL(`${BASE_URL}/inventory/receivers`)
  url.searchParams.set('rql', `ReadOnly.CustomerIdentifier.id==${CUSTOMER_ID};ReadOnly.CreationDate=ge=${dateFrom}`)
  url.searchParams.set('detail',     'All')
  url.searchParams.set('itemdetail', 'None')
  url.searchParams.set('pgsiz',      String(PAGE_SIZE))
  url.searchParams.set('pgnum',      String(pgnum))
  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/hal+json' }
  })
  if (!res.ok) throw new Error(`Receivers fetch failed: ${res.status}`)
  return res.json()
}

async function fetchOne(token: string, receiverId: string) {
  const url = new URL(`${BASE_URL}/inventory/receivers/${receiverId}`)
  url.searchParams.set('detail',     'All')
  url.searchParams.set('itemdetail', 'All')
  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/hal+json' }
  })
  if (!res.ok) throw new Error(`Single receiver fetch failed: ${res.status}`)
  return res.json()
}

function mapReceiver(receiver: any) {
  const ro = receiver.readOnly ?? {}
  if (ro.status !== STATUS_OPEN) return null

  const receiptAdviceNum = receiver.ReceiptAdviceNumber ?? receiver.receiptAdviceNumber ?? null

  return {
    receiver_id:        ro.receiverId,
    transaction_num:    ro.receiverId,
    reference_num:      receiver.referenceNum ?? '—',
    po_num:             receiver.poNum ?? '—',
    receipt_advice_num: receiptAdviceNum,
    arrival_date:       receiver.arrivalDate ?? null,
    creation_date:      ro.creationDate ?? null,
    customer:           ro.customerIdentifier?.name ?? 'Nation.LA',
    tracking_num:       receiver.trackingNumber ?? '—',
    status:             ro.status,
    on_hold:            false,
    total_qty:          0,
    line_count:         0,
    skus:               [],
    cached_at:          new Date().toISOString(),
  }
}

function mapDetail(receiver: any) {
  const ro    = receiver.readOnly ?? {}
  const items = receiver._embedded?.[RECEIVER_ITEM_KEY] ?? []

  const lines = items.map((item: any) => {
    const saved: Record<string,string> = {}
    ;(item.savedElements ?? []).forEach((el: any) => { saved[el.name] = el.value })
    return {
      sku:         item.itemIdentifier?.sku ?? '—',
      qty:         parseFloat(item.qty ?? 0),
      onHold:      item.onHold ?? false,
      location:    item.locationInfo?.display ?? '—',
      palletLabel: item.palletInfo?.label ?? '—',
      po:          saved['PO'] ?? receiver.poNum ?? '—',
      upc:         saved['UPC Case Code'] ?? '—',
      color:       saved['CL'] ?? '—',
      lineNum:     saved['Retailer Line Item Number'] ?? '—',
    }
  })

  const hasHold  = lines.some((l: any) => l.onHold)
  const skus     = [...new Set(lines.map((l: any) => l.sku))]
  const totalQty = lines.reduce((s: number, l: any) => s + l.qty, 0)

  return {
    receiverId:         ro.receiverId,
    transactionNum:     ro.receiverId,
    referenceNum:       receiver.referenceNum ?? '—',
    poNum:              receiver.poNum ?? '—',
    receiptAdviceNum:   receiver.ReceiptAdviceNumber ?? receiver.receiptAdviceNumber ?? null,
    arrivalDate:        receiver.arrivalDate ?? null,
    customer:           ro.customerIdentifier?.name ?? 'Nation.LA',
    trackingNum:        receiver.trackingNumber ?? '—',
    onHold:             hasHold,
    totalQty,
    lineCount:          lines.length,
    skus,
    lines,
  }
}

async function refreshCache(sb: any, dateFrom: string) {
  const token  = await getToken()
  const first  = await fetchPage(token, 1, dateFrom)
  const total  = first.totalResults ?? 0
  const pages  = Math.ceil(total / PAGE_SIZE)
  const all    = [...(first._embedded?.[RECEIVER_KEY] ?? [])]

  // Fetch pages in batches of 3 to avoid timeout
  for (let pg = 2; pg <= pages; pg += 3) {
    const batch   = Array.from({ length: Math.min(3, pages - pg + 1) }, (_, i) => fetchPage(token, pg + i, dateFrom))
    const results = await Promise.all(batch)
    results.forEach(d => all.push(...(d._embedded?.[RECEIVER_KEY] ?? [])))
  }

  const records = all.map(mapReceiver).filter(Boolean)

  if (records.length > 0) {
    // Upsert in chunks of 100
    for (let i = 0; i < records.length; i += 100) {
      const chunk = records.slice(i, i + 100)
      const { error } = await sb.from('receivers_cache').upsert(chunk, { onConflict: 'receiver_id' })
      if (error) throw new Error(`Upsert failed: ${error.message}`)
    }
  }

  // Remove closed receivers from cache ONLY if they have no discrepancy flag
  // Flagged records must stay visible on dashboard regardless of Extensiv status
  if (dateFrom === '2026-04-07') {
    const openIds = records.map((r: any) => r.receiver_id)
    if (openIds.length > 0) {
      // Get all flagged receiver IDs from receipts_flags
      const { data: flagged } = await sb
        .from('receipts_flags')
        .select('receiver_id')
        .not('discrepancy_type', 'is', null)

      const flaggedIds = (flagged ?? []).map((f: any) => f.receiver_id)

      // Only delete closed receivers that are NOT flagged
      const safeToDelete = (await sb
        .from('receivers_cache')
        .select('receiver_id')
        .not('receiver_id', 'in', `(${openIds.join(',')})`))
        .data?.filter((r: any) => !flaggedIds.includes(r.receiver_id))
        .map((r: any) => r.receiver_id) ?? []

      if (safeToDelete.length > 0) {
        await sb.from('receivers_cache').delete().in('receiver_id', safeToDelete)
      }
    }
  }

  await sb.from('cache_meta').upsert({ key: 'last_refreshed', value: new Date().toISOString() })
  return records.length
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const url        = new URL(req.url)
    const receiverId = url.searchParams.get('id')
    const doRefresh  = url.searchParams.get('refresh') === '1'
    const doFull     = url.searchParams.get('full') === '1'

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Single receiver detail — check cache first
    if (receiverId) {
      // Check if we have a cached detail (less than 1 hour old)
      const { data: cachedDetail } = await sb
        .from('receiver_detail_cache')
        .select('*')
        .eq('receiver_id', receiverId)
        .single()

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

      if (cachedDetail && cachedDetail.cached_at > oneHourAgo) {
        return new Response(JSON.stringify({ detail: cachedDetail.detail, fromCache: true }), {
          headers: { ...cors, 'Content-Type': 'application/json' }
        })
      }

      // Fetch fresh from Extensiv
      const token  = await getToken()
      const raw    = await fetchOne(token, receiverId)
      const detail = mapDetail(raw)

      // Cache it
      await sb.from('receiver_detail_cache').upsert({
        receiver_id: parseInt(receiverId),
        detail: detail,
        cached_at: new Date().toISOString()
      }, { onConflict: 'receiver_id' })

      return new Response(JSON.stringify({ detail, fromCache: false }), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    // Full refresh — manual trigger, Apr 7 onwards
    if (doFull) {
      const count = await refreshCache(sb, '2026-04-07')
      return new Response(JSON.stringify({ refreshed: true, type: 'full', count }), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    // Incremental refresh — cron trigger, last 7 days only (fast)
    if (doRefresh) {
      const cutoff  = new Date()
      cutoff.setDate(cutoff.getDate() - 7)
      const dateFrom = cutoff.toISOString().split('T')[0]
      const count    = await refreshCache(sb, dateFrom)
      return new Response(JSON.stringify({ refreshed: true, type: 'incremental', count }), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    // Serve from cache
    const { data: cached, error } = await sb
      .from('receivers_cache')
      .select('*')
      .order('arrival_date', { ascending: false })

    if (error) throw new Error(`Cache read failed: ${error.message}`)

    const { data: meta } = await sb
      .from('cache_meta')
      .select('value')
      .eq('key', 'last_refreshed')
      .single()

    const records = (cached ?? []).map((r: any) => ({
      receiverId:       r.receiver_id,
      transactionNum:   r.transaction_num,
      referenceNum:     r.reference_num,
      poNum:            r.po_num,
      receiptAdviceNum: r.receipt_advice_num,
      arrivalDate:      r.arrival_date,
      customer:         r.customer,
      trackingNum:      r.tracking_num,
      onHold:           r.on_hold,
      totalQty:         r.total_qty,
      lineCount:        r.line_count,
      skus:             r.skus ?? [],
      lines:            [],
      _detailLoaded:    false,
    }))

    return new Response(JSON.stringify({
      records,
      total:         records.length,
      lastRefreshed: meta?.value ?? null,
      fromCache:     true,
    }), {
      headers: { ...cors, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error('extensiv-proxy error:', err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    })
  }
})
