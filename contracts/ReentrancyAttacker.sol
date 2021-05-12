//SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.6.8;

interface IAuctionModified {
    function createBid(bytes32 auctionId, uint256 amount) external payable;
}

contract ReentrancyAttacker {
    uint256 counter = 0;

    // Allows the contract to place a bid.
    function relayBid(
        address auction,
        bytes32 auctionId,
        uint256 amount
    ) external payable {
        IAuctionModified(auction).createBid{value: amount}(auctionId, amount);
    }

    receive() external payable {
        IAuctionModified(msg.sender).createBid{value: msg.value}(0, msg.value);
    }
}
