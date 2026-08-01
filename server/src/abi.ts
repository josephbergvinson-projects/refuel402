// ABI fragments for the SaucerSwap V2 router surface we sponsor, plus ERC-20 approve.
// SaucerSwap V2 is a Uniswap V3-style periphery; WHBAR unwrap function names are
// configurable because the fork renames the WETH9 helpers.
import { parseAbi } from "viem";

export const routerAbi = parseAbi([
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function exactOutput((bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum)) payable returns (uint256 amountIn)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function unwrapWHBAR(uint256 amountMinimum, address recipient) payable",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function refundETH() payable",
  "function refundHBAR() payable",
  "function sweepToken(address token, uint256 amountMinimum, address recipient) payable",
]);

export const v1RouterAbi = parseAbi([
  "function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[] amounts)",
  "function swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export const erc20WrapperAbi = parseAbi([
  "function htsCounterpart(address erc20Token) view returns (address)",
  "function rates(address erc20Token) view returns (uint256)",
  "function wrap(address erc20Token, address to, uint256 erc20Amount)",
]);

// IHRC719 (HIP-719): every HTS token exposes these at its own EVM address.
// associate()/dissociate() take no args and make msg.sender (dis)associated.
// Selectors verified on-chain: associate()=0x0a754de6, isAssociated()=0x4d8fdd6d.
export const ihrc719Abi = parseAbi([
  "function associate() returns (int64 responseCode)",
  "function dissociate() returns (int64 responseCode)",
  "function isAssociated() view returns (bool)",
]);

/** Bare calldata for IHRC719 associate() — the 4-byte selector, no arguments. */
export const ASSOCIATE_SELECTOR = "0x0a754de6";
export const IS_ASSOCIATED_SELECTOR = "0x4d8fdd6d";

export const quoterAbi = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
  "function quoteExactOutput(bytes path, uint256 amountOut) returns (uint256 amountIn, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
