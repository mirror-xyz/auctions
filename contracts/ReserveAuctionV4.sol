// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.6.8;
pragma experimental ABIEncoderV2;

// OpenZeppelin library for performing math operations without overflows.
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
// OpenZeppelin security library for preventing reentrancy attacks.
import {
    ReentrancyGuard
} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
// For interacting with Zora's Market contract.
import {IMarket} from "./interfaces/IMarket.sol";
// For checking `supportsInterface`.
import {IERC165} from "@openzeppelin/contracts/introspection/IERC165.sol";
// Smaller version of IMedia.
import {IMediaModified} from "./interfaces/IMediaModified.sol";

interface IERC721Minimal {
    function transferFrom(
        address from,
        address to,
        uint256 tokenId
    ) external;

    function ownerOf(uint256 tokenId) external view returns (address owner);
}

interface IWETH {
    function deposit() external payable;

    function transfer(address to, uint256 value) external returns (bool);
}

contract ReserveAuctionV4 is ReentrancyGuard {
    // Use OpenZeppelin's SafeMath library to prevent overflows.
    using SafeMath for uint256;

    // ============ Constants ============

    // The minimum amount of time left in an auction after a new bid is created; 15 min.
    uint16 public constant TIME_BUFFER = 900;
    // The ETH needed above the current bid for a new bid to be valid; 0.001 ETH.
    uint8 public constant MIN_BID_INCREMENT_PERCENT = 10;
    // Interface constant for ERC721, to check values in constructor.
    bytes4 private constant ERC721_INTERFACE_ID = 0x80ac58cd;
    // Allows external read `getVersion()` to return a version for the auction.
    uint256 private constant RESERVE_AUCTION_VERSION = 1;

    // ============ Immutable Storage ============

    // The address of the zNFT contract, so we know when to split fees.
    address public immutable zoraContract;
    // The address of the WETH contract, so that ETH can be transferred via
    // WETH if native ETH transfers fail.
    address public immutable wethAddress;
    // The address that initially is able to recover assets.
    address public immutable adminRecoveryAddress;

    // ============ Mutable Storage ============

    /**
     * To start, there will be an admin account that can recover funds
     * if anything goes wrong. Later, this public flag will be irrevocably
     * set to false, removing any admin privileges forever.
     *
     * To check if admin recovery is enabled, call the public function `adminRecoveryEnabled()`.
     */
    bool private _adminRecoveryEnabled;
    /**
     * The account `adminRecoveryAddress` can also pause the contracts
     * while _adminRecoveryEnabled is enabled. This prevents people from using
     * the contract if there is a known problem with it.
     */
    bool private _paused;

    // A mapping of all of the auctions currently running.
    mapping(bytes32 => Auction) public auctions;

    // ============ Structs ============

    struct Auction {
        address nftContract;
        uint256 tokenId;
        // The value of the current highest bid.
        uint256 amount;
        // The amount of time that the auction should run for,
        // after the first bid was made.
        uint256 duration;
        // The time of the first bid.
        uint256 firstBidTime;
        // The minimum price of the first bid.
        uint256 reservePrice;
        uint8 curatorFeePercent;
        // The address of the auction's curator. The curator
        // can cancel the auction if it hasn't had a bid yet.
        address curator;
        // The address of the current highest bid.
        address payable bidder;
        // The address that should receive funds once the NFT is sold.
        address payable fundsRecipient;
    }

    // ============ Events ============

    // All of the details of a new auction,
    // with an index created for the tokenId.
    event AuctionCreated(
        uint256 indexed tokenId,
        address nftContractAddress,
        uint256 duration,
        uint256 reservePrice,
        uint8 curatorFeePercent,
        address curator,
        address fundsRecipient,
        bytes32 auctionId
    );

    // All of the details of a new bid,
    // with an index created for the tokenId.
    event AuctionBid(
        bytes32 indexed auctionId,
        address nftContractAddress,
        address sender,
        uint256 value
    );

    // All of the details of an auction's cancelation,
    // with an index created for the tokenId.
    event AuctionCanceled(
        bytes32 indexed auctionId,
        address nftContractAddress,
        address curator
    );

    // All of the details of an auction's close,
    // with an index created for the tokenId.
    event AuctionEnded(
        bytes32 indexed auctionId,
        address nftContractAddress,
        address curator,
        address winner,
        uint256 amount,
        address payable fundsRecipient
    );

    // When the curator recevies fees, emit the details including the amount,
    // with an index created for the tokenId.
    event CuratorFeePercentTransfer(
        bytes32 indexed auctionId,
        address curator,
        uint256 amount
    );

    // Emitted in the case that the contract is paused.
    event Paused(address account);
    // Emitted when the contract is unpaused.
    event Unpaused(address account);

    // ============ Modifiers ============

    // Reverts if the sender is not admin, or admin
    // functionality has been turned off.
    modifier onlyAdminRecovery() {
        require(
            // The sender must be the admin address, and
            // adminRecovery must be set to true.
            adminRecoveryAddress == msg.sender && adminRecoveryEnabled(),
            "Caller does not have admin privileges"
        );
        _;
    }

    // Reverts if the sender is not the auction's curator.
    modifier onlyCurator(bytes32 tokenId) {
        require(
            auctions[tokenId].curator == msg.sender,
            "Can only be called by auction curator"
        );
        _;
    }

    // Reverts if the contract is paused.
    modifier whenNotPaused() {
        require(!paused(), "Contract is paused");
        _;
    }

    // Reverts if the auction does not exist.
    modifier auctionExists(bytes32 auctionId) {
        // The auction exists if the curator is not null.
        require(!auctionCuratorIsNull(auctionId), "Auction doesn't exist");
        _;
    }

    // Reverts if the auction is expired.
    modifier auctionNotExpired(bytes32 auctionId) {
        require(
            // Auction is not expired if there's never been a bid, or if the
            // current time is less than the time at which the auction ends.
            auctions[auctionId].firstBidTime == 0 ||
                block.timestamp < auctionEnds(auctionId),
            "Auction expired"
        );
        _;
    }

    // Reverts if the auction is not complete.
    // Auction is complete if there was a bid, and the time has run out.
    modifier auctionComplete(bytes32 tokenId) {
        require(
            // Auction is complete if there has been a bid, and the current time
            // is greater than the auction's end time.
            auctions[tokenId].firstBidTime > 0 &&
                block.timestamp >= auctionEnds(tokenId),
            "Auction hasn't completed"
        );
        _;
    }

    // ============ Constructor ============

    constructor(
        address zoraContract_,
        address wethAddress_,
        address adminRecoveryAddress_
    ) public {
        require(
            IERC165(zoraContract_).supportsInterface(ERC721_INTERFACE_ID),
            "Contract at zoraContract_ address does not support NFT interface"
        );
        // Initialize immutable memory.
        zoraContract = zoraContract_;
        wethAddress = wethAddress_;
        adminRecoveryAddress = adminRecoveryAddress_;
        // Initialize mutable memory.
        _paused = false;
        _adminRecoveryEnabled = true;
    }

    // ============ Create Auction ============

    function createAuction(
        uint256 tokenId,
        uint256 duration,
        uint256 reservePrice,
        uint8 curatorFeePercent,
        address curator,
        address payable fundsRecipient,
        address nftContract
    ) external nonReentrant whenNotPaused {
        bytes32 auctionId = getAuctionId(nftContract, tokenId);
        require(auctionCuratorIsNull(auctionId), "Auction already exists");
        // Check basic input requirements are reasonable.
        require(curator != address(0));
        require(fundsRecipient != address(0));
        require(curatorFeePercent < 100, "Curator fee should be < 100");
        // Initialize the auction details, including null values.
        auctions[auctionId] = Auction({
            tokenId: tokenId,
            duration: duration,
            reservePrice: reservePrice,
            curatorFeePercent: curatorFeePercent,
            curator: curator,
            fundsRecipient: fundsRecipient,
            amount: 0,
            firstBidTime: 0,
            bidder: address(0),
            nftContract: nftContract
        });
        // Transfer the NFT into this auction contract, from whoever owns it.
        IERC721Minimal(nftContract).transferFrom(
            IERC721Minimal(nftContract).ownerOf(tokenId),
            address(this),
            tokenId
        );
        // Emit an event describing the new auction.
        emit AuctionCreated(
            tokenId,
            nftContract,
            duration,
            reservePrice,
            curatorFeePercent,
            curator,
            fundsRecipient,
            auctionId
        );
    }

    // ============ Create Bid ============

    function createBid(bytes32 auctionId, uint256 amount)
        external
        payable
        nonReentrant
        whenNotPaused
        auctionExists(auctionId)
        auctionNotExpired(auctionId)
    {
        // Validate that the user's expected bid value matches the ETH deposit.
        require(amount == msg.value, "Amount doesn't equal msg.value");
        require(amount > 0, "Amount must be greater than 0");
        // Check if the current bid amount is 0.
        if (auctions[auctionId].amount == 0) {
            // If so, it is the first bid.
            auctions[auctionId].firstBidTime = block.timestamp;
            // We only need to check if the bid matches reserve bid for the first bid,
            // since future checks will need to be higher than any previous bid.
            require(
                amount >= auctions[auctionId].reservePrice,
                "Must bid reservePrice or more"
            );
        } else {
            // Check that the new bid is sufficiently higher than the previous bid, by
            // the percentage defined as MIN_BID_INCREMENT_PERCENT.
            require(
                amount >=
                    auctions[auctionId].amount.add(
                        // Add 10% of the current bid to the current bid.
                        auctions[auctionId]
                            .amount
                            .mul(MIN_BID_INCREMENT_PERCENT)
                            .div(100)
                    ),
                "Must bid more than last bid by MIN_BID_INCREMENT_PERCENT amount"
            );

            // Refund the previous bidder.
            transferETHOrWETH(
                auctions[auctionId].bidder,
                auctions[auctionId].amount
            );
        }
        // Update the current auction.
        auctions[auctionId].amount = amount;
        auctions[auctionId].bidder = msg.sender;
        // Compare the auction's end time with the current time plus the 15 minute extension,
        // to see whether we're near the auctions end and should extend the auction.
        if (auctionEnds(auctionId) < block.timestamp.add(TIME_BUFFER)) {
            // We add onto the duration whenever time increment is required, so
            // that the auctionEnds at the current time plus the buffer.
            auctions[auctionId].duration += block
                .timestamp
                .add(TIME_BUFFER)
                .sub(auctionEnds(auctionId));
        }
        // Emit the event that a bid has been made.
        emit AuctionBid(
            auctionId,
            auctions[auctionId].nftContract,
            msg.sender,
            amount
        );
    }

    function getAuctionId(address nftContract, uint256 tokenId)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(nftContract, tokenId));
    }

    // ============ End Auction ============

    function endAuction(bytes32 auctionId)
        external
        nonReentrant
        whenNotPaused
        auctionComplete(auctionId)
    {
        // Store relevant auction data in memory for the life of this function.
        address winner = auctions[auctionId].bidder;
        uint256 amount = auctions[auctionId].amount;
        address curator = auctions[auctionId].curator;
        uint8 curatorFeePercent = auctions[auctionId].curatorFeePercent;
        address payable fundsRecipient = auctions[auctionId].fundsRecipient;
        // We don't use safeTransferFrom, to prevent reverts at this point,
        // which would break the auction.
        IERC721Minimal(auctions[auctionId].nftContract).transferFrom(
            address(this),
            winner,
            auctions[auctionId].tokenId
        );
        // First handle the curator's fee.
        if (curatorFeePercent > 0) {
            // Determine the curator amount, which is some percent of the total.
            uint256 curatorAmount = amount.mul(curatorFeePercent).div(100);
            // Send it to the curator.
            transferETHOrWETH(curator, curatorAmount);
            // Subtract the curator amount from the total funds available
            // to send to the funds recipient and original NFT creator.
            amount = amount.sub(curatorAmount);
            // Emit the details of the transfer as an event.
            emit CuratorFeePercentTransfer(auctionId, curator, curatorAmount);
        }

        if (auctions[auctionId].nftContract == zoraContract) {
            // Get the address of the original creator, so that we can split shares
            // if appropriate.
            address payable nftCreator =
                payable(
                    address(
                        IMediaModified(zoraContract).tokenCreators(
                            auctions[auctionId].tokenId
                        )
                    )
                );
            // If the creator and the recipient of the funds are the same
            // (and we expect this to be common), we can just do one transaction.
            if (nftCreator == fundsRecipient) {
                transferETHOrWETH(nftCreator, amount);
            } else {
                // Otherwise, we should determine the percent that goes to the creator.
                // Collect share data from Zora.
                uint256 creatorAmount =
                    // Call the splitShare function on the market contract, which
                    // takes in a Decimal and an amount.
                    IMarket(IMediaModified(zoraContract).marketContract())
                        .splitShare(
                        // Fetch the decimal from the BidShares data on the market.
                        IMarket(IMediaModified(zoraContract).marketContract())
                            .bidSharesForToken(auctions[auctionId].tokenId)
                            .creator,
                        // Specify the amount.
                        amount
                    );
                // Send the creator's share to the creator.
                transferETHOrWETH(nftCreator, creatorAmount);
                // Send the remainder of the amount to the funds recipient.
                transferETHOrWETH(fundsRecipient, amount.sub(creatorAmount));
            }
        }

        // Emit an event describing the end of the auction.
        emit AuctionEnded(
            auctionId,
            auctions[auctionId].nftContract,
            curator,
            winner,
            amount,
            fundsRecipient
        );

        // Remove all auction data for this token from storage.
        delete auctions[auctionId];
    }

    // ============ Cancel Auction ============

    function cancelAuction(bytes32 auctionId)
        external
        nonReentrant
        auctionExists(auctionId)
        onlyCurator(auctionId)
    {
        // Check that there hasn't already been a bid for this NFT.
        require(
            uint256(auctions[auctionId].firstBidTime) == 0,
            "Auction already started"
        );
        // Pull the creator address before removing the auction.
        address curator = auctions[auctionId].curator;
        // Transfer the NFT back to the curator.
        IERC721Minimal(auctions[auctionId].nftContract).transferFrom(
            address(this),
            curator,
            auctions[auctionId].tokenId
        );
        // Emit an event describing that the auction has been canceled.
        emit AuctionCanceled(
            auctionId,
            auctions[auctionId].nftContract,
            curator
        );
        // Remove all data about the auction.
        delete auctions[auctionId];
    }

    // ============ Admin Functions ============

    // Irrevocably turns off admin recovery.
    function turnOffAdminRecovery() external onlyAdminRecovery {
        _adminRecoveryEnabled = false;
    }

    function pauseContract() external onlyAdminRecovery {
        _paused = true;
        emit Paused(msg.sender);
    }

    function unpauseContract() external onlyAdminRecovery {
        _paused = false;
        emit Unpaused(msg.sender);
    }

    // Allows the admin to transfer any NFT from this contract
    // to the recovery address.
    function recoverNFT(bytes32 auctionId) external onlyAdminRecovery {
        IERC721Minimal(auctions[auctionId].nftContract).transferFrom(
            // From the auction contract.
            address(this),
            // To the recovery account.
            adminRecoveryAddress,
            // For the specified token.
            auctions[auctionId].tokenId
        );
    }

    // Allows the admin to transfer any ETH from this contract to the recovery address.
    function recoverETH(uint256 amount)
        external
        onlyAdminRecovery
        returns (bool success)
    {
        // Attempt an ETH transfer to the recovery account, and return true if it succeeds.
        success = attemptETHTransfer(adminRecoveryAddress, amount);
    }

    // ============ Miscellaneous Public and External ============

    // Returns true if the contract is paused.
    function paused() public view returns (bool) {
        return _paused;
    }

    // Returns true if admin recovery is enabled.
    function adminRecoveryEnabled() public view returns (bool) {
        return _adminRecoveryEnabled;
    }

    // Returns the version of the deployed contract.
    function getVersion() external pure returns (uint256 version) {
        version = RESERVE_AUCTION_VERSION;
    }

    // ============ Private Functions ============

    // Will attempt to transfer ETH, but will transfer WETH instead if it fails.
    function transferETHOrWETH(address to, uint256 value) private {
        // Try to transfer ETH to the given recipient.
        if (!attemptETHTransfer(to, value)) {
            // If the transfer fails, wrap and send as WETH, so that
            // the auction is not impeded and the recipient still
            // can claim ETH via the WETH contract (similar to escrow).
            IWETH(wethAddress).deposit{value: value}();
            IWETH(wethAddress).transfer(to, value);
            // At this point, the recipient can unwrap WETH.
        }
    }

    // Sending ETH is not guaranteed complete, and the method used here will return false if
    // it fails. For example, a contract can block ETH transfer, or might use
    // an excessive amount of gas, thereby griefing a new bidder.
    // We should limit the gas used in transfers, and handle failure cases.
    function attemptETHTransfer(address to, uint256 value)
        private
        returns (bool)
    {
        // Here increase the gas limit a reasonable amount above the default, and try
        // to send ETH to the recipient.
        // NOTE: This might allow the recipient to attempt a limited reentrancy attack.
        (bool success, ) = to.call{value: value, gas: 30000}("");
        return success;
    }

    // Returns true if the auction's curator is set to the null address.
    function auctionCuratorIsNull(bytes32 auctionId)
        private
        view
        returns (bool)
    {
        // The auction does not exist if the curator is the null address,
        // since the NFT would not have been transferred in `createAuction`.
        return auctions[auctionId].curator == address(0);
    }

    // Returns the timestamp at which an auction will finish.
    function auctionEnds(bytes32 auctionId) private view returns (uint256) {
        // Derived by adding the auction's duration to the time of the first bid.
        // NOTE: duration can be extended conditionally after each new bid is added.
        return
            auctions[auctionId].firstBidTime.add(auctions[auctionId].duration);
    }
}
