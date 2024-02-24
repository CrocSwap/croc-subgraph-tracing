/// <reference path="../node_modules/assemblyscript/std/assembly/index.d.ts" />

// Import basic data types
import { BigInt, Bytes, ByteArray, Address, BigDecimal, ethereum, crypto, dataSource } from "@graphprotocol/graph-ts"

// Import interfaces for call handlers
import { SwapCall } from "../generated/CrocSwapDex/CrocSwapDex"
import { UserCmdCall as HotProxyUserCmdCall } from "../generated/HotProxy/HotProxy"
import { UserCmdCall as ColdPathUserCmdCall, ProtocolCmdCall } from "../generated/ColdPath/ColdPath"
import { ERC20 } from "../generated/ColdPath/ERC20"
import { SweepSwapCall } from "../generated/MicroPaths/MicroPaths"

// Import interfaces for events that are used to replace call handlers for networks that don't support Parity tracing
import { CrocSwap } from "../generated/CrocSwapDex/CrocSwapDex"
import { CrocHotCmd } from "../generated/HotProxy/HotProxy"
import { CrocColdCmd, CrocColdProtocolCmd } from "../generated/ColdPath/ColdPath"
import { CrocMicroSwap } from "../generated/MicroPaths/MicroPaths"

import { AggEvent, LatestIndex, Pool, Swap, Token } from "../generated/schema"

/****************************** DATA FETCHING ******************************/

function fetchTokenDecimals(tokenAddress: Address): BigInt {
  let contract = ERC20.bind(tokenAddress)
  let decimalResult = contract.try_decimals()
  if (!decimalResult.reverted) {
    return BigInt.fromI32(decimalResult.value as i32)
  }
  return BigInt.fromI32(18)
}

/***************************** DATA MANIPULATION *****************************/
// Conversions between different data types, unpacking packed data, etc.

// Swaps the endianness of an i32
function swapEndianI32(x: i32): i32 {
  return ((x & 0xff) << 24) | ((x & 0xff00) << 8) | ((x >> 8) & 0xff00) | ((x >> 24) & 0xff)
}

// Converts a Q64.64 fixed-point number in BigInt format to a floating-point BigDecimal
export function fixedToFloatingPoint(x: BigInt): BigDecimal {
  return x.times(x).divDecimal(new BigDecimal(BigInt.fromI32(2).pow(128)))
}

// Performs the equivalent of Solidity's abi.encode(...) on an array of values
export function encodeArray(arr: Array<ethereum.Value>): Bytes {
  const tuple = ethereum.Value.fromTuple(changetype<ethereum.Tuple>(arr))
  return ethereum.encode(tuple)!
}

// Left-pads a hex string with 0s until it's length 64 and converts into a Bytes array
export function leftPadHexString(x: string): Bytes {
  return Bytes.fromHexString(x.padStart(64, "0"))
}

// Converts a BigInt to a 64-bit Bytes array
export function convertBigIntToBytes(x: BigInt): Bytes {
  return leftPadHexString(x.toHex())
}

// Converts a big-endian i32 into a little-endian 64-bit Bytes array
export function convertI32ToBytes(x: i32): Bytes {
  return leftPadHexString(ByteArray.fromI32(swapEndianI32(x)).toHex())
}

// Converts a boolean into a 64-bit Bytes array representing either 1 (true) or 0 (false)
export function convertBooleanToBytes(x: boolean): Bytes {
  return convertI32ToBytes(x ? 1 : 0)
}

// Given bytedata, decodes it into separate parameters based on a specified function signature
export function decodeAbi(data: Bytes, signature: string): ethereum.Tuple {
  return ethereum.decode(signature, data)!.toTuple()
}

/******************************* OBJECT HASHING ******************************/
// Generates unique hashes corresponding to different types of entities (pools,
// etc.) that are typically just a bunch of variables concatenated or packed
// together.

// Returns the unique pool hash corresponding to a base token, quote token, and pool index
export function getPoolHash(base: Address, quote: Address, poolIdx: BigInt): Bytes {
  const tupleArray: Array<ethereum.Value> = [
    ethereum.Value.fromAddress(base),
    ethereum.Value.fromAddress(quote),
    ethereum.Value.fromUnsignedBigInt(poolIdx),
  ]
  const encoded = encodeArray(tupleArray)
  return changetype<Bytes>(crypto.keccak256(encoded))
}

// Casts the unique pool index number to bytes
export function getPoolTemplateBytes(poolIdx: BigInt): Bytes {
  const tupleArray: Array<ethereum.Value> = [ethereum.Value.fromUnsignedBigInt(poolIdx)]
  const encoded = encodeArray(tupleArray)
  return changetype<Bytes>(crypto.keccak256(encoded))
}

// Generates unique hash for a CrocKnockoutCross event
export function getKnockoutCrossHash(
  block: BigInt,
  transaction: Bytes,
  poolHash: Bytes,
  tick: i32,
  isBid: boolean,
  pivotTime: BigInt,
  feeMileage: BigInt,
): Bytes {
  return convertBigIntToBytes(block)
    .concat(transaction)
    .concat(poolHash)
    .concat(convertI32ToBytes(tick))
    .concat(convertBooleanToBytes(isBid))
    .concat(convertBigIntToBytes(pivotTime))
    .concat(convertBigIntToBytes(feeMileage))
}

// Generates unique hash for a UserBalance object denoting that a given user has interacted with a given token
export function getUserBalanceHash(user: Address, token: Address): Bytes {
  return user.concat(token)
}

export function getLatestIndexID(entityType: String, transaction: Bytes): Bytes {
  const tupleArray: Array<ethereum.Value> = [
    ethereum.Value.fromString(entityType.toString()),
    ethereum.Value.fromBytes(transaction),
  ]
  const encoded = encodeArray(tupleArray)
  return changetype<Bytes>(crypto.keccak256(encoded))
}

const AGG_ENTITY_LABEL = "aggEvent"

/************************* UNIQUE EVENT ID GENERATION ************************/
// Any given event (e.g. a liquidity addition) might happen multiple times
// in a given transaction, so to assign a unique identifier to each event,
// we need to concatenate a transaction hash with a unique "call index" which
// increments upward from zero for every unique pair of (event/entity type,
// transaction hash). These functions handle the bookkeeping for retrieval
// of unique identifiers constructed in this way.

export function getUniqueCallID(transaction: Bytes, callIndex: i32): Bytes {
  return transaction.concat(convertI32ToBytes(callIndex))
}

export function getNextCallIndex(entityType: String, transaction: Bytes): i32 {
  const latestIndexID = getLatestIndexID(entityType, transaction)
  const latestIndex = LatestIndex.load(latestIndexID)
  if (latestIndex === null) {
    const latestIndex_ = new LatestIndex(latestIndexID)
    latestIndex_.callIndex = -1
    latestIndex_.save()
    return 0
  } else {
    return latestIndex.callIndex + 1
  }
}

export function saveCallIndex(entityType: String, transaction: Bytes, callIndex: i32): void {
  const latestIndex = LatestIndex.load(getLatestIndexID(entityType, transaction))!
  latestIndex.callIndex = callIndex
  latestIndex.save()
}

/********* GENERIC HELPERS FOR HANDLING COMMON ENTITY MANIPULATIONS **********/

// Creates Swap entities
export function handleSwap(
  transaction: Bytes,
  userAddress: Address,
  poolHash: Bytes,
  blockNumber: BigInt,
  transactionIndex: BigInt,
  timestamp: BigInt,
  isBuy: boolean,
  inBaseQty: boolean,
  qty: BigInt,
  limitPrice: BigInt | null,
  minOut: BigInt | null,
  baseFlow: BigInt,
  quoteFlow: BigInt,
  callSource: string,
  dex: string,
): void {
  // Get unique entity ID
  const entityType = "swap"
  const callIndex = getNextCallIndex(entityType, transaction)

  // Record the swap
  const swap = new Swap(getUniqueCallID(transaction, callIndex))

  swap.hash = transaction
  swap.callIndex = callIndex
  swap.timestamp = timestamp
  swap.block = blockNumber

  swap.user = userAddress
  swap.pool = poolHash

  swap.baseFlow = baseFlow
  swap.quoteFlow = quoteFlow

  if (quoteFlow.abs() > BigInt.fromI32(0)) {
    swap.price = baseFlow.abs().divDecimal(quoteFlow.abs().toBigDecimal())
  }
  swap.save()

  updatePoolVolume(poolHash, baseFlow, quoteFlow)

  // Save new entity ID
  saveCallIndex(entityType, transaction, callIndex)

  const eventIndex = getNextCallIndex(AGG_ENTITY_LABEL, transaction)

  const agg = new AggEvent(getUniqueCallID(transaction, eventIndex))
  agg.transactionHash = transaction
  agg.eventIndex = eventIndex
  agg.block = blockNumber
  agg.time = timestamp
  agg.pool = poolHash
  agg.baseFlow = baseFlow
  agg.quoteFlow = quoteFlow
  agg.swapPrice = swap.price
  agg.inBaseQty = inBaseQty
  agg.isSwap = true
  agg.isLiq = false
  agg.isFeeChange = false
  agg.isTickSkewed = false
  agg.flowsAtMarket = true
  agg.bidTick = 0
  agg.askTick = 0
  agg.feeRate = 0
  agg.save()

  saveCallIndex(AGG_ENTITY_LABEL, transaction, eventIndex)
}

// Given a set of liquidity pool parameters (base token, quote token,
// pool index), logs a corresponding Pool entity
export function createPool(base: Address, quote: Address, poolIdx: BigInt): void {
  const poolHash = getPoolHash(base, quote, poolIdx)
  if (Pool.load(poolHash) === null) {
    const pool = new Pool(poolHash)
    pool.base = base
    pool.quote = quote
    pool.poolIdx = poolIdx
    pool.baseVolume = BigInt.fromI32(0)
    pool.quoteVolume = BigInt.fromI32(0)
    pool.save()
  }

  createToken(base)
  createToken(quote)
}

export function updatePoolVolume(poolHash: Bytes, baseFlow: BigInt, quoteFlow: BigInt): void {
  const pool = Pool.load(poolHash)
  if (pool === null) {
    return
  }
  pool.baseVolume = pool.baseVolume.plus(baseFlow.abs())
  pool.quoteVolume = pool.quoteVolume.plus(quoteFlow.abs())
  pool.save()

  updateTokenVolume(pool.base, baseFlow)
  updateTokenVolume(pool.quote, quoteFlow)
}

export function createToken(token: Address): void {
  if (Token.load(token) === null) {
    const tokenEntity = new Token(token)
    tokenEntity.decimals = fetchTokenDecimals(token)
    tokenEntity.totalVolume = BigInt.fromI32(0)
    tokenEntity.save()
  }
}

export function updateTokenVolume(token: Bytes, flow: BigInt): void {
  const tokenEntity = Token.load(token)
  if (tokenEntity === null) {
    return
  }
  tokenEntity.totalVolume = tokenEntity.totalVolume.plus(flow.abs())
  tokenEntity.save()
}

/*********************** HANDLERS FOR DIRECT SWAP CALLS **********************/

// Handler for a swap() call made to CrocSwapDex
export function handleDirectSwapCall(call: SwapCall): void {
  handleSwap(
    call.transaction.hash,
    call.transaction.from,
    getPoolHash(call.inputs.base, call.inputs.quote, call.inputs.poolIdx),
    call.block.number,
    call.transaction.index,
    call.block.timestamp,
    call.inputs.isBuy,
    call.inputs.inBaseQty,
    call.inputs.qty,
    call.inputs.limitPrice,
    call.inputs.minOut,
    call.outputs.baseQuote,
    call.outputs.quoteFlow,
    "hotpath",
    "croc",
  )
}

// event CrocSwap (address indexed base, address indexed quote, uint256 poolIdx, bool isBuy, bool inBaseQty, uint128 qty, uint16 tip, uint128 limitPrice, uint128 minOut, uint8 reserveFlags, int128 baseFlow, int128 quoteFlow);
export function handleDirectSwapEvent(event: CrocSwap): void {
  handleSwap(
    event.transaction.hash,
    event.transaction.from,
    getPoolHash(event.params.base, event.params.quote, event.params.poolIdx),
    event.block.number,
    event.transaction.index,
    event.block.timestamp,
    event.params.isBuy,
    event.params.inBaseQty,
    event.params.qty,
    event.params.limitPrice,
    event.params.minOut,
    event.params.baseFlow,
    event.params.quoteFlow,
    "hotpath_event",
    "croc",
  )
}

/************************ HANDLERS FOR HOTPROXY SWAPS ************************/

export function handleHotProxy(
  inputs: Bytes,
  transaction: ethereum.Transaction,
  block: ethereum.Block,
  callSource: string,
): void {
  const params = decodeAbi(inputs, "(address,address,uint256,bool,bool,uint128,uint16,uint128,uint128,uint8)")
  const base = params[0].toAddress()
  const quote = params[1].toAddress()
  const poolIdx = params[2].toBigInt()
  const isBuy = params[3].toBoolean()
  const inBaseQty = params[4].toBoolean()
  const qty = params[5].toBigInt()
  const limitPrice = params[7].toBigInt()
  const minOut = params[8].toBigInt()
  handleSwap(
    transaction.hash,
    transaction.from,
    getPoolHash(base, quote, poolIdx),
    block.number,
    transaction.index,
    block.timestamp,
    isBuy,
    inBaseQty,
    qty,
    limitPrice,
    minOut,
    BigInt.fromI32(0), // replace
    BigInt.fromI32(0), // replace
    callSource,
    "croc",
  )
}

// Handler for a userCmd() swap call made to HotProxy
export function handleHotProxyCall(call: HotProxyUserCmdCall): void {
  handleHotProxy(call.inputs.input, call.transaction, call.block, "hotproxy")
}

// event CrocHotCmd (bytes input, int128 baseFlow, int128 quoteFlow);
export function handleHotProxyEvent(event: CrocHotCmd): void {
  handleHotProxy(event.params.input, event.transaction, event.block, "hotproxy_event")
}

/******************* HANDLERS FOR COLDPATH USERCMD() CALLS *******************/

export function handleColdPath(inputs: Bytes): void {
  const initPoolCode = 71

  const cmdCode = inputs[31]
  if (cmdCode === initPoolCode) {
    const params = decodeAbi(inputs, "(uint8,address,address,uint256,uint128)")
    const base = params[1].toAddress()
    const quote = params[2].toAddress()
    const poolIdx = params[3].toBigInt()
    createPool(base, quote, poolIdx)
  }
}

// Handler for a ColdPath userCmd call that initializes a new liquidity pool
export function handleColdPathCall(call: ColdPathUserCmdCall): void {
  handleColdPath(call.inputs.cmd)
}

// event CrocColdCmd (bytes input);
export function handleColdPathEvent(event: CrocColdCmd): void {
  handleColdPath(event.params.input)
}

/********************* HANDLERS FOR ALL MICROPATHS CALLS *********************/

// Handler for a MicroPaths sweepSwap() call (as part of a long-form order) that performs a swap operation on a single pool
export function handleSweepSwapCall(call: SweepSwapCall): void {
  handleSwap(
    call.transaction.hash,
    call.transaction.from,
    call.inputs.pool.hash_,
    call.block.number,
    call.transaction.index,
    call.block.timestamp,
    call.inputs.swap.isBuy_,
    call.inputs.swap.inBaseQty_,
    call.inputs.swap.qty_,
    call.inputs.swap.limitPrice_,
    null, // slippage is not checked at the per-swap level in a long-form order
    call.outputs.accum.baseFlow_,
    call.outputs.accum.quoteFlow_,
    "micropath",
    "croc",
  )
}

// event CrocMicroSwap(bytes input, bytes output);
export function handleSweepSwapEvent(event: CrocMicroSwap): void {
  //const inputs = decodeAbi(event.params.input, "((uint128,uint128,uint128,uint64,uint64),int24,(bool,bool,uint8,uint128,uint128),((uint8,uint16,uint8,uint16,uint8,uint8,uint8),bytes32,address))")
  //const outputs = decodeAbi(event.params.output, "((int128,int128,uint128,uint128),uint128,uint128,uint128,uint64,uint64)")
  /* const poolHash = inputs[18].toBytes()
  const isBuy = inputs[6].toBoolean()
  const inBaseQty = inputs[7].toBoolean()
  const qty = inputs[9].toBigInt()
  const limitPrice = inputs[10].toBigInt()
  const baseFlow = outputs[0].toBigInt()
  const quoteFlow = outputs[1].toBigInt() 

  handleSwap(
    event.transaction.hash,
    event.transaction.from,
    poolHash,
    event.block.number,
    event.transaction.index,
    event.block.timestamp,
    isBuy,
    inBaseQty,
    qty,
    limitPrice,
    null, // slippage is not checked at the per-swap level in a long-form order
    baseFlow,
    quoteFlow,
    "micropath_event",
    "croc"
  ) */
}
