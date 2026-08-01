// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IAllowanceTransferPermit2 {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}

interface IERC20Refuel402 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

interface IRefuel402Erc20Wrapper {
    function htsCounterpart(address erc20Token) external view returns (address);
    function rates(address erc20Token) external view returns (uint256);
    function wrap(address erc20Token, address to, uint256 erc20Amount) external;
}

interface IRefuel402ExactOutputRouter {
    struct ExactOutputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256 amountIn);
    function unwrapWHBAR(uint256 amountMinimum, address recipient) external payable;
}

/// @notice Exact, one-time x402 settlement and pre-authorized atomic refuel proxy for Hedera EVM.
/// @dev Owners sign Permit2's EIP-712 domain. Refuel402 witnesses bind every payment/refuel field;
/// Permit2 binds the spender to this proxy. The autonomous refuel path is permissionless to relay:
/// the witness, cap, route hash, deadline, and replay map are the complete owner authority.
contract Refuel402ExactPermit2Proxy {
    error FacilitatorOnly();
    error ReentrantCall();
    error InvalidPayment();
    error InvalidRefuelAuthorization();
    error WrongChain(uint256 expected, uint256 actual);
    error PaymentExpired(uint256 deadline, uint256 currentTime);
    error RefuelAuthorizationExpired(uint256 deadline, uint256 currentTime);
    error PermitMismatch();
    error PaymentAlreadyConsumed(bytes32 paymentId);
    error RefuelAuthorizationAlreadyConsumed(bytes32 authorizationId);
    error RouteMismatch(bytes32 expected, bytes32 actual);
    error CapExceeded(uint256 cap, uint256 spent);
    error ExactHbarDeliveryMismatch(uint256 expected, uint256 actual);
    error TokenOperationFailed(address token);
    error TokenAssociationFailed(address token, int64 responseCode);
    error TokenDustRetained(address token, uint256 amount);
    error WrapperOutputMismatch(uint256 expected, uint256 actual);

    bytes32 public constant PAYMENT_TYPEHASH = keccak256(
        "Refuel402ExactPayment(address payer,address token,uint256 amount,address recipient,uint256 chainId,uint256 nonce,uint256 deadline,address spender,bytes32 contextHash)"
    );

    string public constant WITNESS_TYPE_STRING =
        "Refuel402ExactPayment witness)Refuel402ExactPayment(address payer,address token,uint256 amount,address recipient,uint256 chainId,uint256 nonce,uint256 deadline,address spender,bytes32 contextHash)TokenPermissions(address token,uint256 amount)";

    bytes32 public constant REFUEL_AUTHORIZATION_TYPEHASH = keccak256(
        "Refuel402RefuelAuthorization(address owner,address token,uint256 maxAmountIn,uint256 exactHbarTinybar,uint256 serviceFeeAmount,address recipient,uint256 journeyNonce,uint256 deadline,bytes32 routeHash)"
    );

    string public constant REFUEL_WITNESS_TYPE_STRING =
        "Refuel402RefuelAuthorization witness)Refuel402RefuelAuthorization(address owner,address token,uint256 maxAmountIn,uint256 exactHbarTinybar,uint256 serviceFeeAmount,address recipient,uint256 journeyNonce,uint256 deadline,bytes32 routeHash)TokenPermissions(address token,uint256 amount)";

    bytes32 public constant REFUEL_ROUTE_TYPEHASH = keccak256(
        "Refuel402Route(address wrapper,address htsToken,address router,address whbar,uint256 wrapperRate,bytes32 swapPathHash)"
    );

    struct ExactPayment {
        address payer;
        address token;
        uint256 amount;
        address recipient;
        uint256 chainId;
        uint256 nonce;
        uint256 deadline;
        address spender;
        bytes32 contextHash;
    }

    struct RefuelAuthorization {
        address owner;
        address token;
        uint256 maxAmountIn;
        uint256 exactHbarTinybar;
        uint256 serviceFeeAmount;
        address recipient;
        uint256 journeyNonce;
        uint256 deadline;
        bytes32 routeHash;
    }

    /// @dev The current product supports one route-bound V2 hop: wrapped HTS input -> WHBAR.
    /// The hash binds every executable contract/token plus the wrapper conversion rate and fee tier.
    struct RefuelBalanceBaseline {
        uint256 token;
        uint256 htsToken;
    }

    struct RefuelRoute {
        address wrapper;
        address htsToken;
        address router;
        address whbar;
        uint256 wrapperRate;
        /// Full V3 exact-output path: output token first, input token last,
        /// with a 3-byte fee between each pair. Signed whole, so the owner
        /// authorizes one specific route of any hop count and the relayer
        /// cannot substitute a different pool, fee tier, or intermediate token.
        bytes swapPath;
    }

    IAllowanceTransferPermit2 public immutable permit2;
    address public immutable facilitator;
    uint256 private entered;
    mapping(bytes32 paymentId => bool consumed) public consumedPayments;
    mapping(bytes32 authorizationId => bool consumed) public consumedRefuelAuthorizations;

    event ExactPaymentSettled(
        bytes32 indexed paymentId,
        bytes32 indexed contextHash,
        address indexed payer,
        address token,
        uint256 amount,
        address recipient,
        uint256 chainId,
        uint256 nonce,
        uint256 deadline,
        address facilitator
    );

    event RefuelExecuted(
        address indexed owner,
        bytes32 indexed journeyId,
        bytes32 indexed authorizationId,
        address token,
        uint256 spent,
        uint256 refunded,
        uint256 hbarDelivered,
        uint256 serviceFeeAmount,
        bytes32 routeHash
    );

    constructor(address permit2_, address facilitator_) {
        if (permit2_ == address(0) || facilitator_ == address(0)) revert InvalidPayment();
        permit2 = IAllowanceTransferPermit2(permit2_);
        facilitator = facilitator_;
    }

    modifier onlyFacilitator() {
        if (msg.sender != facilitator) revert FacilitatorOnly();
        _;
    }

    modifier nonReentrant() {
        if (entered != 0) revert ReentrantCall();
        entered = 1;
        _;
        entered = 0;
    }

    function paymentWitness(ExactPayment calldata payment) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PAYMENT_TYPEHASH,
                payment.payer,
                payment.token,
                payment.amount,
                payment.recipient,
                payment.chainId,
                payment.nonce,
                payment.deadline,
                payment.spender,
                payment.contextHash
            )
        );
    }

    function paymentId(ExactPayment calldata payment) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                payment.payer,
                payment.token,
                payment.amount,
                payment.recipient,
                payment.chainId,
                payment.nonce,
                payment.deadline,
                payment.spender,
                payment.contextHash
            )
        );
    }

    function refuelAuthorizationWitness(RefuelAuthorization calldata authorization) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                REFUEL_AUTHORIZATION_TYPEHASH,
                authorization.owner,
                authorization.token,
                authorization.maxAmountIn,
                authorization.exactHbarTinybar,
                authorization.serviceFeeAmount,
                authorization.recipient,
                authorization.journeyNonce,
                authorization.deadline,
                authorization.routeHash
            )
        );
    }

    function refuelAuthorizationId(RefuelAuthorization calldata authorization) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                authorization.owner,
                authorization.token,
                authorization.maxAmountIn,
                authorization.exactHbarTinybar,
                authorization.serviceFeeAmount,
                authorization.recipient,
                authorization.journeyNonce,
                authorization.deadline,
                authorization.routeHash
            )
        );
    }

    function refuelRouteHash(RefuelRoute calldata route) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                REFUEL_ROUTE_TYPEHASH,
                route.wrapper,
                route.htsToken,
                route.router,
                route.whbar,
                route.wrapperRate,
                keccak256(route.swapPath)
            )
        );
    }

    function settle(
        ExactPayment calldata payment,
        IAllowanceTransferPermit2.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external onlyFacilitator nonReentrant returns (bytes32 id) {
        if (
            payment.payer == address(0) ||
            payment.token == address(0) ||
            payment.recipient == address(0) ||
            payment.amount == 0 ||
            payment.spender != address(this) ||
            payment.contextHash == bytes32(0)
        ) revert InvalidPayment();
        if (payment.chainId != block.chainid) revert WrongChain(block.chainid, payment.chainId);
        if (payment.deadline < block.timestamp) revert PaymentExpired(payment.deadline, block.timestamp);
        if (
            permit.permitted.token != payment.token ||
            permit.permitted.amount != payment.amount ||
            permit.nonce != payment.nonce ||
            permit.deadline != payment.deadline
        ) revert PermitMismatch();

        id = paymentId(payment);
        if (consumedPayments[id]) revert PaymentAlreadyConsumed(id);
        consumedPayments[id] = true;

        permit2.permitWitnessTransferFrom(
            permit,
            IAllowanceTransferPermit2.SignatureTransferDetails({
                to: payment.recipient,
                requestedAmount: payment.amount
            }),
            payment.payer,
            paymentWitness(payment),
            WITNESS_TYPE_STRING,
            signature
        );

        emit ExactPaymentSettled(
            id,
            payment.contextHash,
            payment.payer,
            payment.token,
            payment.amount,
            payment.recipient,
            payment.chainId,
            payment.nonce,
            payment.deadline,
            msg.sender
        );
    }

    struct RefuelExecutionResult {
        uint256 spent;
        uint256 refunded;
        uint256 hbarDelivered;
    }

    /// @notice Atomically pull a signed cap, charge the service fee, wrap only the live attempt
    /// maximum, buy exact WHBAR, unwrap exact HBAR to the owner, and return all unused value.
    /// @param wrapAmount Raw ERC20 units to convert for this attempt. It may be below the signed cap.
    /// @param tradeAmountInMaximum HTS base units the exact-output router may spend this attempt.
    function executeRefuel(
        RefuelAuthorization calldata authorization,
        IAllowanceTransferPermit2.PermitTransferFrom calldata permit,
        RefuelRoute calldata route,
        uint256 wrapAmount,
        uint256 tradeAmountInMaximum,
        bytes calldata signature
    ) external nonReentrant returns (bytes32 id) {
        _validateRefuel(authorization, permit, route, wrapAmount, tradeAmountInMaximum);
        id = refuelAuthorizationId(authorization);
        if (consumedRefuelAuthorizations[id]) revert RefuelAuthorizationAlreadyConsumed(id);
        consumedRefuelAuthorizations[id] = true;
        // Baselines, NOT a zero assertion. Requiring an absolute zero balance made
        // the contract brickable by anyone: a 1-base-unit transfer to this address
        // is unsolicited, unrecoverable (there is no sweep, owner, or rescue), and
        // would have reverted every future refuel permanently. Conservation is the
        // real invariant — this call must neither gain nor lose token balance —
        // and a stray donation simply sits here without blocking anybody.
        RefuelBalanceBaseline memory baseline = RefuelBalanceBaseline({
            token: IERC20Refuel402(authorization.token).balanceOf(address(this)),
            htsToken: IERC20Refuel402(route.htsToken).balanceOf(address(this))
        });
        _associateToken(route.htsToken);
        _pullRefuelAuthorization(baseline.token, authorization, permit, signature);
        RefuelExecutionResult memory result = _executeRefuelRoute(
            baseline,
            authorization,
            route,
            wrapAmount,
            tradeAmountInMaximum
        );
        _emitRefuelExecuted(authorization, id, result);
    }

    function _emitRefuelExecuted(
        RefuelAuthorization calldata authorization,
        bytes32 id,
        RefuelExecutionResult memory result
    ) private {
        emit RefuelExecuted(
            authorization.owner,
            bytes32(authorization.journeyNonce),
            id,
            authorization.token,
            result.spent,
            result.refunded,
            result.hbarDelivered,
            authorization.serviceFeeAmount,
            authorization.routeHash
        );
    }

    function _validateRefuel(
        RefuelAuthorization calldata authorization,
        IAllowanceTransferPermit2.PermitTransferFrom calldata permit,
        RefuelRoute calldata route,
        uint256 wrapAmount,
        uint256 tradeAmountInMaximum
    ) private view {
        if (
            authorization.owner == address(0) ||
            authorization.token == address(0) ||
            authorization.recipient != authorization.owner ||
            authorization.maxAmountIn == 0 ||
            authorization.exactHbarTinybar == 0 ||
            authorization.serviceFeeAmount >= authorization.maxAmountIn ||
            authorization.routeHash == bytes32(0) ||
            route.htsToken == address(0) ||
            route.router == address(0) ||
            route.whbar == address(0) ||
            route.wrapperRate == 0 ||
            !_validSwapPath(route)
        ) revert InvalidRefuelAuthorization();
        if (authorization.deadline < block.timestamp) {
            revert RefuelAuthorizationExpired(authorization.deadline, block.timestamp);
        }
        if (
            permit.permitted.token != authorization.token ||
            permit.permitted.amount != authorization.maxAmountIn ||
            permit.nonce != authorization.journeyNonce ||
            permit.deadline != authorization.deadline
        ) revert PermitMismatch();
        bytes32 actualRouteHash = refuelRouteHash(route);
        if (actualRouteHash != authorization.routeHash) {
            revert RouteMismatch(authorization.routeHash, actualRouteHash);
        }
        if (route.wrapper == address(0)) {
            if (route.htsToken != authorization.token || route.wrapperRate != 1 || wrapAmount != tradeAmountInMaximum) {
                revert RouteMismatch(authorization.routeHash, actualRouteHash);
            }
        } else if (
            IRefuel402Erc20Wrapper(route.wrapper).htsCounterpart(authorization.token) != route.htsToken ||
            IRefuel402Erc20Wrapper(route.wrapper).rates(authorization.token) != route.wrapperRate
        ) revert RouteMismatch(authorization.routeHash, actualRouteHash);
        uint256 swapCap = authorization.maxAmountIn - authorization.serviceFeeAmount;
        if (
            wrapAmount == 0 ||
            wrapAmount > swapCap ||
            wrapAmount % route.wrapperRate != 0 ||
            tradeAmountInMaximum == 0 ||
            tradeAmountInMaximum > wrapAmount / route.wrapperRate
        ) revert CapExceeded(swapCap, wrapAmount);
    }

    /// This refuel must neither gain nor lose token balance for the contract.
    function _requireBalancesRestored(
        address tokenAddress,
        address htsTokenAddress,
        RefuelBalanceBaseline memory baseline
    ) private view {
        uint256 tokenNow = IERC20Refuel402(tokenAddress).balanceOf(address(this));
        uint256 htsNow = IERC20Refuel402(htsTokenAddress).balanceOf(address(this));
        if (tokenNow != baseline.token) {
            uint256 tokenDifference = tokenNow > baseline.token
                ? tokenNow - baseline.token
                : baseline.token - tokenNow;
            revert TokenDustRetained(tokenAddress, tokenDifference);
        }
        if (htsNow != baseline.htsToken) {
            uint256 htsDifference = htsNow > baseline.htsToken
                ? htsNow - baseline.htsToken
                : baseline.htsToken - htsNow;
            revert TokenDustRetained(htsTokenAddress, htsDifference);
        }
    }

    function _pullRefuelAuthorization(
        uint256 tokenBalanceBaseline,
        RefuelAuthorization calldata authorization,
        IAllowanceTransferPermit2.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) private {
        permit2.permitWitnessTransferFrom(
            permit,
            IAllowanceTransferPermit2.SignatureTransferDetails({
                to: address(this),
                requestedAmount: authorization.maxAmountIn
            }),
            authorization.owner,
            refuelAuthorizationWitness(authorization),
            REFUEL_WITNESS_TYPE_STRING,
            signature
        );
        uint256 tokenBalanceAfterPull = IERC20Refuel402(authorization.token).balanceOf(address(this));
        if (
            tokenBalanceAfterPull < tokenBalanceBaseline ||
            tokenBalanceAfterPull - tokenBalanceBaseline != authorization.maxAmountIn
        ) revert TokenOperationFailed(authorization.token);
    }

    function _executeRefuelRoute(
        RefuelBalanceBaseline memory baseline,
        RefuelAuthorization calldata authorization,
        RefuelRoute calldata route,
        uint256 wrapAmount,
        uint256 tradeAmountInMaximum
    ) private returns (RefuelExecutionResult memory result) {
        IERC20Refuel402 token = IERC20Refuel402(authorization.token);
        IERC20Refuel402 htsToken = IERC20Refuel402(route.htsToken);
        _safeTransfer(token, authorization.token, facilitator, authorization.serviceFeeAmount);
        uint256 expectedWrapped = wrapAmount / route.wrapperRate;
        if (route.wrapper != address(0)) {
            _forceApprove(token, authorization.token, route.wrapper, wrapAmount);
            IRefuel402Erc20Wrapper(route.wrapper).wrap(authorization.token, address(this), wrapAmount);
            _forceApprove(token, authorization.token, route.wrapper, 0);
        }

        _requireAttemptBalance(
            htsToken,
            baseline.htsToken,
            expectedWrapped,
            tradeAmountInMaximum,
            route.wrapper != address(0)
        );

        uint256 tradeAmountIn = _swapExactHbar(authorization, route, htsToken, tradeAmountInMaximum);
        // Everything above the baseline belongs to this refuel and goes back to the
        // owner; the baseline itself is somebody else's stray donation and is left
        // untouched rather than handed to whoever refuels next.
        uint256 leftoverHts = htsToken.balanceOf(address(this)) - baseline.htsToken;
        if (leftoverHts > 0) _safeTransfer(htsToken, route.htsToken, authorization.owner, leftoverHts);
        uint256 refundWeth = token.balanceOf(address(this)) - baseline.token;
        if (refundWeth > 0) _safeTransfer(token, authorization.token, authorization.owner, refundWeth);

        result.spent = authorization.serviceFeeAmount + tradeAmountIn * route.wrapperRate;
        if (result.spent > authorization.maxAmountIn) revert CapExceeded(authorization.maxAmountIn, result.spent);
        result.refunded = authorization.maxAmountIn - result.spent;
        if (refundWeth + leftoverHts * route.wrapperRate != result.refunded) {
            revert WrapperOutputMismatch(result.refunded, refundWeth + leftoverHts * route.wrapperRate);
        }
        result.hbarDelivered = authorization.exactHbarTinybar;
        _requireBalancesRestored(authorization.token, route.htsToken, baseline);
    }

    function _requireAttemptBalance(
        IERC20Refuel402 htsToken,
        uint256 htsBalanceBaseline,
        uint256 expectedWrapped,
        uint256 tradeAmountInMaximum,
        bool exactWrapperOutput
    ) private view {
        uint256 wrappedBalance = htsToken.balanceOf(address(this));
        if (wrappedBalance < htsBalanceBaseline) {
            revert WrapperOutputMismatch(expectedWrapped, 0);
        }
        uint256 attemptBalance = wrappedBalance - htsBalanceBaseline;
        if (
            (exactWrapperOutput && attemptBalance != expectedWrapped) ||
            (!exactWrapperOutput && attemptBalance < expectedWrapped)
        ) revert WrapperOutputMismatch(expectedWrapped, attemptBalance);
        if (tradeAmountInMaximum > attemptBalance) {
            revert CapExceeded(tradeAmountInMaximum, attemptBalance);
        }
    }

    /**
     * Structural check on the signed exact-output path.
     *
     * The path is authorized as a whole by `routeHash`, so this does not decide
     * WHICH route is acceptable — the owner's signature already did. It only
     * rejects paths that are malformed or that do not start and end where this
     * contract requires, so a well-formed signature can never be pointed at a
     * swap that delivers something other than HBAR for the wrapped asset.
     *
     * V3 exact-output encoding is reversed: 20-byte output token, then repeating
     * (3-byte fee, 20-byte token). So length is 20 + 23n for n hops, n >= 1.
     */
    function _validSwapPath(RefuelRoute calldata route) private pure returns (bool) {
        uint256 length = route.swapPath.length;
        if (length < 43 || (length - 20) % 23 != 0) return false;
        // First token is the OUTPUT of the exact-output swap: WHBAR.
        if (address(bytes20(route.swapPath[0:20])) != route.whbar) return false;
        // Last token is the INPUT the contract actually holds and approves.
        if (address(bytes20(route.swapPath[length - 20:length])) != route.htsToken) return false;
        return true;
    }

    function _swapExactHbar(
        RefuelAuthorization calldata authorization,
        RefuelRoute calldata route,
        IERC20Refuel402 htsToken,
        uint256 tradeAmountInMaximum
    ) private returns (uint256 tradeAmountIn) {
        _forceApprove(htsToken, route.htsToken, route.router, tradeAmountInMaximum);
        uint256 hbarBefore = authorization.recipient.balance;
        tradeAmountIn = IRefuel402ExactOutputRouter(route.router).exactOutput(
            IRefuel402ExactOutputRouter.ExactOutputParams({
                path: route.swapPath,
                recipient: route.router,
                deadline: authorization.deadline,
                amountOut: authorization.exactHbarTinybar,
                amountInMaximum: tradeAmountInMaximum
            })
        );
        if (tradeAmountIn > tradeAmountInMaximum) revert CapExceeded(tradeAmountInMaximum, tradeAmountIn);
        IRefuel402ExactOutputRouter(route.router).unwrapWHBAR(
            authorization.exactHbarTinybar,
            authorization.recipient
        );
        _forceApprove(htsToken, route.htsToken, route.router, 0);
        uint256 delivered = authorization.recipient.balance - hbarBefore;
        // A floor, not equality. SaucerSwap V2's unwrapWHBAR is Uniswap's
        // unwrapWETH9 renamed: its first argument is a MINIMUM and it unwraps the
        // router's whole WHBAR balance. Demanding exact equality would revert
        // whenever any dust sat in the router — and the owner receiving MORE HBAR
        // than they asked for is never a reason to fail their transfer. The cap on
        // what they spend is enforced separately and is unaffected.
        if (delivered < authorization.exactHbarTinybar) {
            revert ExactHbarDeliveryMismatch(authorization.exactHbarTinybar, delivered);
        }
    }

    function _associateToken(address tokenAddress) private {
        (bool ok, bytes memory result) = tokenAddress.call(hex"0a754de6");
        if (!ok || result.length < 32) revert TokenAssociationFailed(tokenAddress, -1);
        int64 responseCode = abi.decode(result, (int64));
        // HederaResponseCodes.SUCCESS=22; TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT=194.
        if (responseCode != 22 && responseCode != 194) {
            revert TokenAssociationFailed(tokenAddress, responseCode);
        }
    }

    function _safeTransfer(IERC20Refuel402 token, address tokenAddress, address to, uint256 amount) private {
        (bool ok, bytes memory result) = tokenAddress.call(
            abi.encodeWithSelector(token.transfer.selector, to, amount)
        );
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TokenOperationFailed(tokenAddress);
        }
    }

    function _forceApprove(IERC20Refuel402 token, address tokenAddress, address spender, uint256 amount) private {
        (bool ok, bytes memory result) = tokenAddress.call(
            abi.encodeWithSelector(token.approve.selector, spender, amount)
        );
        if (ok && (result.length == 0 || abi.decode(result, (bool)))) return;
        (ok, result) = tokenAddress.call(abi.encodeWithSelector(token.approve.selector, spender, 0));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TokenOperationFailed(tokenAddress);
        (ok, result) = tokenAddress.call(abi.encodeWithSelector(token.approve.selector, spender, amount));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TokenOperationFailed(tokenAddress);
    }
}
