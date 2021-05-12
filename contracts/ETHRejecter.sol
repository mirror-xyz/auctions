//SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.6.8;

interface IAuctionModified {
    function createBid(bytes32 auctionId, uint256 amount) external payable;
}

contract ETHRejecter {
    // Allows the contract to place a bid.
    function relayBid(
        address auction,
        bytes32 auctionId,
        uint256 amount
    ) external payable {
        IAuctionModified(auction).createBid{value: amount}(auctionId, amount);
    }

    receive() external payable {
        // This will revert the ETH payment,
        // even though it's payable.
        assert(1 == 2);
    }
}
