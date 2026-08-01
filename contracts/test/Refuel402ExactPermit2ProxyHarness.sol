// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../Refuel402ExactPermit2Proxy.sol";

contract MockRefuelToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }

    function transferFrom(address owner, address recipient, uint256 amount) external returns (bool) {
        uint256 permitted = allowance[owner][msg.sender];
        require(permitted >= amount, "allowance");
        allowance[owner][msg.sender] = permitted - amount;
        _transfer(owner, recipient, amount);
        return true;
    }

    function associate() external pure returns (int64) {
        return 22;
    }

    function _transfer(address owner, address recipient, uint256 amount) private {
        require(balanceOf[owner] >= amount, "balance");
        balanceOf[owner] -= amount;
        balanceOf[recipient] += amount;
    }
}

contract MockPermit2 is IAllowanceTransferPermit2 {
    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32,
        string calldata,
        bytes calldata
    ) external {
        // The caller is the proxy; the token address is bound in the permit and
        // Permit2 has the owner's ERC-20 allowance in this executable fixture.
        require(MockRefuelToken(permit.permitted.token).transferFrom(
            owner,
            transferDetails.to,
            transferDetails.requestedAmount
        ));
    }
}

contract MockRefuelWrapper {
    MockRefuelToken public immutable raw;
    MockRefuelToken public immutable hts;
    uint256 public immutable rate;

    constructor(MockRefuelToken raw_, MockRefuelToken hts_, uint256 rate_) {
        raw = raw_;
        hts = hts_;
        rate = rate_;
    }

    function htsCounterpart(address erc20Token) external view returns (address) {
        require(erc20Token == address(raw), "raw");
        return address(hts);
    }

    function rates(address erc20Token) external view returns (uint256) {
        require(erc20Token == address(raw), "raw");
        return rate;
    }

    function wrap(address erc20Token, address recipient, uint256 erc20Amount) external {
        require(erc20Token == address(raw), "raw");
        require(erc20Amount % rate == 0, "rate");
        require(raw.transferFrom(msg.sender, address(this), erc20Amount));
        hts.mint(recipient, erc20Amount / rate);
    }
}

contract MockExactOutputRouter is IRefuel402ExactOutputRouter {
    MockRefuelToken public immutable input;
    uint256 public amountIn;
    uint256 public hbarDelivery;
    bool public forceRevert;

    constructor(MockRefuelToken input_) payable {
        input = input_;
    }

    receive() external payable {}

    function setExecution(uint256 amountIn_, uint256 hbarDelivery_, bool forceRevert_) external payable {
        amountIn = amountIn_;
        hbarDelivery = hbarDelivery_;
        forceRevert = forceRevert_;
    }

    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256) {
        require(!forceRevert, "router revert");
        require(amountIn <= params.amountInMaximum, "maximum");
        require(input.transferFrom(msg.sender, address(this), amountIn));
        return amountIn;
    }

    function unwrapWHBAR(uint256, address recipient) external payable {
        (bool ok,) = recipient.call{value: hbarDelivery}("");
        require(ok, "hbar");
    }
}
